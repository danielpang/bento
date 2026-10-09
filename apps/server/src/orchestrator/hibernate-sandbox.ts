import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentRuns, sandboxes } from "@bento/db";
import { ModalDriver, MODAL_REPO_PREPARE_TIMEOUT_MS, MODAL_WARM_WINDOW_MS, type SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { driverForSandbox } from "./sandbox-driver.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/** Queued when a Modal run finishes. Fires after the warm window. */
export const HIBERNATE_SANDBOX_QUEUE = "sandbox.hibernate";

/** Nightly, and once at boot beside the finished-card sweep. */
export const MODAL_SWEEP_QUEUE = "sandbox.modal-sweep";

export { MODAL_WARM_WINDOW_MS };

/**
 * A sandbox is tagged at create, and the row is inserted only after
 * every repository clone. Two clones at the per-repo budget, plus the
 * rest of setup, outlast a 15 minute grace: the sweep was destroying
 * machines that were still being provisioned. An active run is spared
 * regardless of age.
 */
export const MODAL_SWEEP_GRACE_MS = 2 * MODAL_REPO_PREPARE_TIMEOUT_MS + 15 * 60 * 1000;

/** Queue a hibernation after the warm window. A duplicate job is safe: the worker skips a row that is already hibernated. */
export async function armModalHibernation(
  ctx: AppContext,
  sandboxId: string,
  delayMs: number = MODAL_WARM_WINDOW_MS,
): Promise<void> {
  await ctx.boss.send(
    HIBERNATE_SANDBOX_QUEUE,
    { sandboxId },
    { startAfter: new Date(Date.now() + delayMs) },
  );
}

/**
 * How much of the warm window this row still has, counted from the
 * last time something used the machine. Zero once it has passed, or
 * when nothing ever stamped the row.
 *
 * Asked because a job is not armed only by the finish it belongs to.
 * A job that found a run still going arms another, five minutes from
 * whenever it happened to fire, and that one can land seconds after
 * the run ends. Production saw a swarm worker hibernated thirty five
 * seconds after it reported, while its branch was waiting to land.
 */
export function warmWindowLeftMs(lastUsedAt: Date | null, now: number = Date.now()): number {
  if (!lastUsedAt) return 0;
  return Math.max(0, lastUsedAt.getTime() + MODAL_WARM_WINDOW_MS - now);
}

/**
 * A skip is only safe when some later finish will arm the job.
 * A busy row, or a row with a run still going, will not, so the job
 * is armed again. Hibernated and destroyed rows have nothing to stop.
 */
function shouldRearmHibernation(
  row: { provider: string; status: string },
  activeRun: boolean,
): boolean {
  if (row.provider !== "modal") return false;
  if (row.status === "hibernated" || row.status === "destroyed") return false;
  return activeRun || row.status === "busy";
}

/**
 * A run that is queued, starting, or running on this machine's workspace.
 *
 * A card is matched by its feature. A swarm is matched by the swarm,
 * and a worker by its task, so hibernating one leaf does not wait on
 * the planner and hibernating the planner does not wait on a leaf.
 */
async function workspaceHasActiveRun(
  db: { select: AppContext["db"]["select"] },
  row: { featureId: string | null; swarmId: string | null; swarmTaskId: string | null },
): Promise<boolean> {
  if (row.featureId) {
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, row.featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    return rows.length > 0;
  }
  if (row.swarmId) {
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.swarmId, row.swarmId),
          row.swarmTaskId ? eq(agentRuns.swarmTaskId, row.swarmTaskId) : isNull(agentRuns.swarmTaskId),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  return false;
}

/**
 * Whether the hibernation job should leave this row alone.
 *
 * A run that is queued, starting, or running still needs the machine.
 * A row that is already hibernated or destroyed has nothing to snapshot.
 * Anything that is not Modal is not this job's.
 */
export function hibernateShouldSkip(
  row: { provider: string; status: string } | null | undefined,
  activeRun: boolean,
): boolean {
  if (!row || row.provider !== "modal") return true;
  if (row.status === "hibernated" || row.status === "destroyed") return true;
  if (activeRun) return true;
  return false;
}

/**
 * A Modal run that just finished stays warm for five minutes, then
 * this job snapshots it. The row moves to ready now, so the next run
 * in that window sees a live machine and sets it back to busy.
 */
export async function scheduleModalHibernation(ctx: AppContext, runId: string): Promise<void> {
  const [row] = await ctx.db
    .select({
      sandboxId: agentRuns.sandboxId,
      provider: sandboxes.provider,
      status: sandboxes.status,
    })
    .from(agentRuns)
    .innerJoin(sandboxes, eq(sandboxes.id, agentRuns.sandboxId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!row?.sandboxId || row.provider !== "modal") return;
  const [updated] = await ctx.db
    .update(sandboxes)
    .set({ status: "ready", lastUsedAt: new Date() })
    .where(and(eq(sandboxes.id, row.sandboxId), eq(sandboxes.provider, "modal"), eq(sandboxes.status, "busy")))
    .returning({ id: sandboxes.id });
  if (updated) {
    await armModalHibernation(ctx, row.sandboxId);
    return;
  }
  // The row was already ready: this finish would otherwise arm nothing,
  // and the machine would run until the 24 hour cap.
  const [current] = await ctx.db
    .select({ status: sandboxes.status, provider: sandboxes.provider })
    .from(sandboxes)
    .where(eq(sandboxes.id, row.sandboxId))
    .limit(1);
  if (current?.provider === "modal" && current.status === "ready") {
    await armModalHibernation(ctx, row.sandboxId);
  }
}

/**
 * Snapshot, then stop, unless a run has already taken the machine.
 *
 * The feature lock is held across the stop. A start during the snapshot
 * is left running, and a later job is armed. A missing exit snapshot
 * clears the stored image, so the next start says it is a fresh clone.
 */
export async function hibernateSandbox(ctx: AppContext, sandboxId: string): Promise<void> {
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
  if (!row) return;
  const active = await workspaceHasActiveRun(ctx.db, row);
  if (hibernateShouldSkip(row, active) || shouldRearmHibernation(row, active)) {
    if (shouldRearmHibernation(row, active)) await armModalHibernation(ctx, row.id);
    return;
  }
  const warmLeft = warmWindowLeftMs(row.lastUsedAt);
  if (warmLeft > 0) {
    await armModalHibernation(ctx, row.id, warmLeft);
    return;
  }

  const driver = driverForSandbox(ctx.drivers, row);
  if (!(driver instanceof ModalDriver)) return;
  const result = await driver.hibernate(
    {
      externalId: row.externalId,
      provider: "modal",
      workdir: row.workdir,
      ...(row.imageRef ? { imageRef: row.imageRef } : {}),
    },
    {
      finish: async (apply) => {
        let wrote = false;
        await ctx.db.transaction(async (tx) => {
          // The same lock startRunIfIdle takes, held across the stop,
          // so a start either waits until the machine is down or is
          // already visible here and is left running. A card locks its
          // feature. A swarm locks the swarm row, which is the lock a
          // swarm start takes.
          if (row.featureId) {
            await tx.execute(sql`select id from features where id = ${row.featureId} for update`);
          } else if (row.swarmId) {
            await tx.execute(sql`select id from swarms where id = ${row.swarmId} for update`);
          }
          await tx.execute(sql`select id from sandboxes where id = ${row.id} for update`);
          const [current] = await tx
            .select({ status: sandboxes.status })
            .from(sandboxes)
            .where(eq(sandboxes.id, row.id))
            .limit(1);
          const stillActive = await workspaceHasActiveRun(tx, row);
          if (!current || current.status !== "ready" || stillActive) return;
          const imageId = await apply();
          const [updated] = await tx
            .update(sandboxes)
            .set({
              status: "hibernated",
              imageRef: imageId,
              lastUsedAt: new Date(),
            })
            .where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, "ready")))
            .returning({ id: sandboxes.id });
          wrote = Boolean(updated);
        });
        return wrote;
      },
    },
  );
  if (result.committed) return;
  const [after] = await ctx.db
    .select({ status: sandboxes.status, provider: sandboxes.provider })
    .from(sandboxes)
    .where(eq(sandboxes.id, row.id))
    .limit(1);
  if (after && after.provider === "modal" && after.status !== "hibernated" && after.status !== "destroyed") {
    await armModalHibernation(ctx, row.id);
  }
}

/**
 * Boots a hibernated machine again for something that is not a run.
 *
 * The merge queue reads a worker's branch out of the worker's machine
 * and lands it in the swarm's, and a new worker reads the swarm's
 * branch out of the swarm's machine. Either can find the machine
 * hibernated: a planner that takes longer than the warm window to
 * review a report, a landing a person retries an hour later. Reading
 * the row as "not destroyed" and exec'ing into it failed with "is not
 * running", which the landing took for a moved branch until it ran
 * out of attempts.
 *
 * The row goes back to ready with a fresh hibernation armed, the way
 * a rollback that boots a machine leaves it, so the machine is not
 * left running to the 24 hour cap. `network` is what the machine's
 * runs would have been given, because a run in the warm window
 * reuses it as it is.
 */
export async function wakeHibernatedSandbox(
  ctx: AppContext,
  row: typeof sandboxes.$inferSelect,
  network: Pick<SandboxHandle, "network" | "allowedHosts">,
): Promise<void> {
  if (row.status !== "hibernated") return;
  const driver = driverForSandbox(ctx.drivers, row);
  if (!driver.wake) return;
  await driver.wake({
    externalId: row.externalId,
    provider: driver.provider,
    workdir: row.workdir,
    ...(row.imageRef ? { imageRef: row.imageRef } : {}),
    ...network,
  });
  await ctx.db
    .update(sandboxes)
    .set({ status: "ready", lastUsedAt: new Date() })
    .where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, "hibernated")));
  if (row.provider === "modal") await armModalHibernation(ctx, row.id);
}

/**
 * Running Modal sandboxes with no live row.
 *
 * A destroyed row does not count as live: the name can be reused, and
 * a machine still up under it is being billed with nobody looking.
 * The row is matched by the machine's name, so a swarm sandbox is
 * kept the same way a card's is.
 */
export async function sweepOrphanModalSandboxes(ctx: AppContext): Promise<void> {
  const driver = ctx.drivers.get("modal");
  if (!(driver instanceof ModalDriver)) return;
  let running: { externalId: string; tags: Record<string, string> }[];
  try {
    running = await driver.listRunning();
  } catch (err) {
    console.warn("could not list Modal sandboxes:", err);
    ctx.analytics?.captureException(err, null, null, { source: "modal_sweep" });
    return;
  }
  for (const item of running) {
    const featureId = item.tags.bento_feature;
    if (!featureId) continue;
    const [activeRun] = await ctx.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (activeRun) continue;
    // A swarm's tag is its workspace key, not a feature id, so the
    // check above cannot see it. A run that still points at this
    // machine is spared the same way, including one whose row was
    // marked destroyed while the machine was still coming up.
    const [activeOnMachine] = await ctx.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(sandboxes, eq(sandboxes.id, agentRuns.sandboxId))
      .where(and(eq(sandboxes.externalId, item.externalId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (activeOnMachine) continue;
    const created = Number(item.tags.bento_created ?? "0");
    if (Number.isFinite(created) && created > 0 && Date.now() - created < MODAL_SWEEP_GRACE_MS) continue;
    const [live] = await ctx.db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.externalId, item.externalId), ne(sandboxes.status, "destroyed")))
      .limit(1);
    if (live) continue;
    try {
      await driver.destroy({
        externalId: item.externalId,
        provider: "modal",
        workdir: "/workspace",
      });
      console.log(`destroyed orphan Modal sandbox ${item.externalId}`);
    } catch (err) {
      console.warn(`could not destroy orphan Modal sandbox ${item.externalId}:`, err);
      ctx.analytics?.captureException(err, null, null, {
        feature_id: featureId,
        source: "modal_sweep",
      });
    }
  }
}
