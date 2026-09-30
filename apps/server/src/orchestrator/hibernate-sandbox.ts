import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { agentRuns, sandboxes } from "@bento/db";
import { ModalDriver, MODAL_WARM_WINDOW_MS } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { driverForSandbox } from "./sandbox-driver.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/** Queued when a Modal run finishes. Fires after the warm window. */
export const HIBERNATE_SANDBOX_QUEUE = "sandbox.hibernate";

/** Nightly, and once at boot beside the finished-card sweep. */
export const MODAL_SWEEP_QUEUE = "sandbox.modal-sweep";

export { MODAL_WARM_WINDOW_MS };

/**
 * A sandbox created during provision is tagged before its row is
 * inserted, and cloning the repositories can take several minutes.
 * The sweep leaves a machine alone for this long so it does not
 * destroy a sandbox whose row has not landed yet.
 */
const SWEEP_GRACE_MS = 15 * 60 * 1000;

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
 * Snapshot the filesystem, terminate, and record the image.
 *
 * Re-reads the row. A run that started during the warm window, or a
 * row another path already hibernated or destroyed, is left as it is.
 */
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
  if (!updated) return;
  await ctx.boss.send(
    HIBERNATE_SANDBOX_QUEUE,
    { sandboxId: row.sandboxId },
    { startAfter: new Date(Date.now() + MODAL_WARM_WINDOW_MS) },
  );
}

export async function hibernateSandbox(ctx: AppContext, sandboxId: string): Promise<void> {
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
  if (!row) return;
  const active = row.featureId
    ? await ctx.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.featureId, row.featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .limit(1)
    : row.swarmId
      ? await ctx.db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.swarmId, row.swarmId),
              row.swarmTaskId ? eq(agentRuns.swarmTaskId, row.swarmTaskId) : isNull(agentRuns.swarmTaskId),
              inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
            ),
          )
          .limit(1)
      : [];
  if (hibernateShouldSkip(row, active.length > 0)) return;

  const driver = driverForSandbox(ctx.drivers, row);
  if (!(driver instanceof ModalDriver)) return;
  const imageId = await driver.hibernate({
    externalId: row.externalId,
    provider: "modal",
    workdir: row.workdir,
    ...(row.imageRef ? { imageRef: row.imageRef } : {}),
  });
  await ctx.db
    .update(sandboxes)
    .set({
      status: "hibernated",
      ...(imageId ? { imageRef: imageId } : {}),
      lastUsedAt: new Date(),
    })
    .where(and(eq(sandboxes.id, row.id), ne(sandboxes.status, "destroyed")));
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
    const created = Number(item.tags.bento_created ?? "0");
    if (Number.isFinite(created) && created > 0 && Date.now() - created < SWEEP_GRACE_MS) continue;
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
