import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentProfiles, agentRuns, sandboxes, swarmLandings, swarms } from "@bento/db";
import {
  ModalDriver,
  MODAL_REPO_PREPARE_TIMEOUT_MS,
  MODAL_WARM_WINDOW_MS,
  SandboxImageLost,
  type SandboxDriver,
  type SandboxHandle,
} from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { driverForSandbox } from "./sandbox-driver.js";
import { modalNetworkForProject, organizationRestrictsNetwork } from "./sandbox-network.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";

/**
 * How long a landing in flight counts as using its machines. A real
 * landing, checks included, finishes well inside it.
 */
export const LANDING_ACTIVITY_MAX_MS = 30 * 60 * 1000;

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
  await ctx.jobs.send(HIBERNATE_SANDBOX_QUEUE, { sandboxId }, { delayMs });
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
 * A swarm's machines also count a landing that is being performed.
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
    if (rows.length > 0) return true;
    /*
     * A landing in flight is using the machine as much as a run is:
     * it exports from the worker's, imports into the swarm's, and runs
     * the swarm's checks there, which can outlast the warm window. A
     * landing that woke the machine would otherwise have it stopped
     * under its own checks.
     */
    const landings = await db
      .select({ id: swarmLandings.id })
      .from(swarmLandings)
      .where(
        and(
          eq(swarmLandings.swarmId, row.swarmId),
          eq(swarmLandings.status, "landing"),
          // A row whose job died says "landing" forever. Past this it
          // is not keeping anybody's machine awake until the 24 hour cap.
          gt(swarmLandings.startedAt, new Date(Date.now() - LANDING_ACTIVITY_MAX_MS)),
          ...(row.swarmTaskId ? [eq(swarmLandings.taskId, row.swarmTaskId)] : []),
        ),
      )
      .limit(1);
    return landings.length > 0;
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
  /*
   * Busy with nothing running in it: the finish that would have moved
   * the row to ready never did (a run closed by a path that skips it,
   * a process that died between the two writes). Re-arming on "busy"
   * alone did so every five minutes forever, and the machine ran to
   * Modal's cap and started again. Nothing is using it, so it is
   * ready from now and gets a whole warm window, as a finish gives.
   */
  if (row.provider === "modal" && row.status === "busy" && !active) {
    const [released] = await ctx.db
      .update(sandboxes)
      .set({ status: "ready", lastUsedAt: new Date() })
      .where(and(eq(sandboxes.id, row.id), eq(sandboxes.status, "busy")))
      .returning({ id: sandboxes.id });
    if (released) {
      console.log(`sandbox ${row.externalId} was busy with no run in it; ready again`);
      await armModalHibernation(ctx, row.id);
      return;
    }
    // Something else moved the row first. Whatever it is now, the
    // next job decides with fresh eyes.
    await armModalHibernation(ctx, row.id);
    return;
  }
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
            .select({ status: sandboxes.status, lastUsedAt: sandboxes.lastUsedAt })
            .from(sandboxes)
            .where(eq(sandboxes.id, row.id))
            .limit(1);
          const stillActive = await workspaceHasActiveRun(tx, row);
          if (!current || current.status !== "ready" || stillActive) return;
          // Something read from the machine during the snapshot (a
          // worker start, a landing, a push stamp the row as they
          // begin), so its warm window starts again from there.
          if (warmWindowLeftMs(current.lastUsedAt) > 0) return;
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
    .select({ status: sandboxes.status, provider: sandboxes.provider, lastUsedAt: sandboxes.lastUsedAt })
    .from(sandboxes)
    .where(eq(sandboxes.id, row.id))
    .limit(1);
  if (after && after.provider === "modal" && after.status !== "hibernated" && after.status !== "destroyed") {
    await armModalHibernation(ctx, row.id, warmWindowLeftMs(after.lastUsedAt) || MODAL_WARM_WINDOW_MS);
  }
}

/**
 * The machine a row names is gone for good, and the row now says so.
 *
 * Thrown by the wake paths when the provider answered that the machine
 * is not there (a sprite that no longer exists) or that nothing of it
 * can be booted again (a Modal box that stopped with no snapshot left).
 * A lookup that failed is never this: a machine marked destroyed while
 * it still exists is a branch nobody can reach and a machine nobody is
 * looking for. The caller reads its rows again and takes the path it
 * already has for a machine that is gone: a worker's pushed branch, the
 * swarm's branch from GitHub, or a refusal that says the work is lost.
 */
export class SandboxGone extends Error {
  readonly sandboxId: string;
  readonly externalId: string;

  constructor(row: { id: string; externalId: string }, message?: string, cause?: unknown) {
    super(message ?? `sandbox ${row.externalId} no longer exists`, cause === undefined ? undefined : { cause });
    this.name = "SandboxGone";
    this.sandboxId = row.id;
    this.externalId = row.externalId;
  }
}

/**
 * Marks a row destroyed because its machine is gone, only if the row
 * still names the machine that was found gone. The swarm's own row is
 * reused by an upsert when its machine is made again, so a row that
 * moved on meanwhile names a new machine and is left alone.
 */
async function markSandboxGone(
  ctx: AppContext,
  row: Pick<typeof sandboxes.$inferSelect, "id" | "status" | "externalId" | "provider">,
): Promise<boolean> {
  const [updated] = await ctx.db
    .update(sandboxes)
    .set({ status: "destroyed" })
    .where(
      and(
        eq(sandboxes.id, row.id),
        eq(sandboxes.status, row.status),
        eq(sandboxes.externalId, row.externalId),
        eq(sandboxes.provider, row.provider),
      ),
    )
    .returning({ id: sandboxes.id });
  if (updated) console.warn(`sandbox ${row.externalId} is gone; its row now says destroyed`);
  return Boolean(updated);
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
 * The row records the image the machine was booted from, which the
 * driver may have taken over the stored one, and goes back to ready
 * through markSandboxAwake. `network` is what the machine's runs would
 * have been given, because a run in the warm window reuses it as it
 * is. A row reaped while the machine was booting has the new machine
 * destroyed again, because nothing else would ever find it. A machine
 * with no snapshot left to boot from is gone, and its row says so.
 */
export async function wakeHibernatedSandbox(
  ctx: AppContext,
  row: typeof sandboxes.$inferSelect,
  network: Pick<SandboxHandle, "network" | "allowedHosts">,
): Promise<void> {
  if (row.status !== "hibernated") return;
  const driver = driverForSandbox(ctx.drivers, row);
  if (!driver.wake) return;
  const woke = await wakeOrMarkGone(ctx, driver, row, network);
  const awake = await markSandboxAwake(ctx.db, ctx, row.id, woke.imageRef);
  if (awake) return;
  const [current] = await ctx.db
    .select({ status: sandboxes.status })
    .from(sandboxes)
    .where(eq(sandboxes.id, row.id))
    .limit(1);
  // Ready or busy: a run's provision got there first and owns it now.
  if (current && current.status !== "destroyed") return;
  if (woke.booted) {
    await driver.destroy({ externalId: row.externalId, provider: driver.provider, workdir: row.workdir });
  }
  throw new SandboxGone(row, `sandbox ${row.externalId} was reaped while it was being started`);
}

/**
 * Asks a driver that boots machines to make sure this one is running.
 * A machine with nothing left to boot from has its row marked
 * destroyed, and SandboxGone says so; any other failure is thrown as
 * it came, because a provider that blinked is not a machine that is
 * gone.
 */
async function wakeOrMarkGone(
  ctx: AppContext,
  driver: SandboxDriver,
  row: typeof sandboxes.$inferSelect,
  network: Pick<SandboxHandle, "network" | "allowedHosts">,
): Promise<{ booted: boolean; imageRef?: string }> {
  const handle: SandboxHandle = {
    externalId: row.externalId,
    provider: driver.provider,
    workdir: row.workdir,
    ...(row.imageRef ? { imageRef: row.imageRef } : {}),
    ...network,
  };
  try {
    return await driver.wake!(handle, { organizationId: row.organizationId });
  } catch (err) {
    if (!(err instanceof SandboxImageLost)) throw err;
    await markSandboxGone(ctx, row);
    throw new SandboxGone(row, err.message, err);
  }
}

/**
 * A row that says ready or busy, on a driver that boots machines,
 * whose machine may have stopped underneath it: Modal ends every
 * sandbox at its 24 hour cap, and a box can be terminated outside
 * Bento. The row would say live forever and every exec would fail.
 *
 * The driver answers cheaply when the box is running. When it had
 * stopped, it is booted from its exit snapshot or its stored image,
 * the row records the image and is ready again, and the hibernation
 * schedule is armed so the booted machine is not left to the cap.
 */
async function wakeStoppedSandbox(
  ctx: AppContext,
  driver: SandboxDriver,
  row: typeof sandboxes.$inferSelect,
  network: Pick<SandboxHandle, "network" | "allowedHosts">,
): Promise<void> {
  const woke = await wakeOrMarkGone(ctx, driver, row, network);
  if (!woke.booted) return;
  const [updated] = await ctx.db
    .update(sandboxes)
    .set({ status: "ready", lastUsedAt: new Date(), ...(woke.imageRef ? { imageRef: woke.imageRef } : {}) })
    .where(and(eq(sandboxes.id, row.id), inArray(sandboxes.status, ["ready", "busy"])))
    .returning({ provider: sandboxes.provider });
  if (updated) {
    console.log(`sandbox ${row.externalId} had stopped; booted it again from its snapshot`);
    if (updated.provider === "modal") await armModalHibernation(ctx, row.id);
    return;
  }
  const [current] = await ctx.db
    .select({ status: sandboxes.status })
    .from(sandboxes)
    .where(eq(sandboxes.id, row.id))
    .limit(1);
  if (current && current.status !== "destroyed") return;
  await driver.destroy({ externalId: row.externalId, provider: driver.provider, workdir: row.workdir });
  throw new SandboxGone(row, `sandbox ${row.externalId} was reaped while it was being started`);
}

/**
 * On a driver whose machines wake on their own (a sprite), whether the
 * machine is there at all. Only a definite "no" marks the row: a
 * lookup that failed leaves it, and the exec that follows says what
 * went wrong.
 */
async function confirmSandboxExists(
  ctx: AppContext,
  driver: SandboxDriver,
  row: typeof sandboxes.$inferSelect,
): Promise<void> {
  if (!driver.exists || driver.workspace !== "clone") return;
  let present: boolean;
  try {
    present = await driver.exists({ externalId: row.externalId, provider: driver.provider, workdir: row.workdir });
  } catch (err) {
    console.warn(`could not ask whether sandbox ${row.externalId} exists:`, err);
    return;
  }
  if (present) return;
  await markSandboxGone(ctx, row);
  throw new SandboxGone(row);
}

/**
 * A row that is about to be read from, stamped as used now, so the
 * hibernation job does not stop the machine under the read: its
 * finish, under the row's lock, leaves a machine whose warm window
 * this restarted. False when the row was no longer ready.
 */
async function touchReadySandbox(ctx: AppContext, sandboxId: string): Promise<boolean> {
  const [updated] = await ctx.db
    .update(sandboxes)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, "ready")))
    .returning({ id: sandboxes.id });
  return Boolean(updated);
}

/**
 * A hibernated row whose machine was booted again outside a run.
 *
 * Ready, stamped, and on the hibernation schedule, which is where a
 * run that just finished leaves a machine, so a booted machine is not
 * left running to the 24 hour cap. False when the row was no longer
 * hibernated, so the caller can tell a reap or a run took it first.
 * `db` is the caller's, which for a route is its tenant transaction.
 */
export async function markSandboxAwake(
  db: Pick<AppContext["db"], "update">,
  ctx: AppContext,
  sandboxId: string,
  imageRef?: string,
): Promise<boolean> {
  const [updated] = await db
    .update(sandboxes)
    .set({ status: "ready", lastUsedAt: new Date(), ...(imageRef ? { imageRef } : {}) })
    .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, "hibernated")))
    .returning({ provider: sandboxes.provider });
  if (!updated) return false;
  if (updated.provider === "modal") await armModalHibernation(ctx, sandboxId);
  return true;
}

/**
 * Makes sure a swarm's machine, or one of its workers', is there and
 * running before something that is not a run reads from it, with the
 * network its own runs get.
 *
 * On a driver that boots machines (Modal), a hibernated machine is
 * woken, and so is a ready or busy one whose box stopped underneath
 * its row. A ready row is stamped as used first, so the hibernation
 * job does not stop it during the read; one that was hibernated just
 * before the stamp is woken instead. On a driver whose machines wake
 * on their own (a sprite), the machine is only asked to exist.
 * Either way, a machine that is gone for good is marked destroyed and
 * SandboxGone is thrown, so the caller can take its gone path rather
 * than exec into nothing.
 *
 * `profileId` is the agent whose runs use the machine: the planner's
 * for the swarm's own, the leaf's for a worker's. An organization
 * that restricts the network has its allowlist built from that
 * agent's hosts, as provision would; with no such agent a hibernated
 * machine is not booted at all, rather than booted with the network
 * open, and a running one is used as it is.
 */
export async function wakeSwarmSandbox(
  ctx: AppContext,
  row: typeof sandboxes.$inferSelect,
  swarm: Pick<typeof swarms.$inferSelect, "projectId" | "organizationId">,
  profileId: string | null,
): Promise<void> {
  if (row.status === "destroyed") throw new SandboxGone(row);
  // A run is making this machine; there is nothing to wake yet.
  if (row.status === "provisioning") return;
  const driver = driverForSandbox(ctx.drivers, row);
  if (!driver.wake) {
    await confirmSandboxExists(ctx, driver, row);
    return;
  }
  let current = row;
  if (current.status === "ready" && !(await touchReadySandbox(ctx, current.id))) {
    const [reread] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, row.id)).limit(1);
    if (!reread || reread.status === "destroyed") throw new SandboxGone(row);
    current = reread;
  }
  const network = await swarmSandboxNetwork(ctx, swarm, profileId);
  if (!network) {
    if (current.status === "hibernated") {
      throw new Error(
        `sandbox ${current.externalId} is hibernated, and the agent it was made for is gone, so it cannot be started with this organization's network restriction.`,
      );
    }
    return;
  }
  if (current.status === "hibernated") {
    await wakeHibernatedSandbox(ctx, current, network);
    return;
  }
  if (current.status === "ready" || current.status === "busy") {
    await wakeStoppedSandbox(ctx, driver, current, network);
  }
}

/**
 * The network a swarm machine's own runs get, or null when it cannot
 * be built: the organization restricts the network and the agent the
 * machine was made for is gone.
 */
async function swarmSandboxNetwork(
  ctx: AppContext,
  swarm: Pick<typeof swarms.$inferSelect, "projectId" | "organizationId">,
  profileId: string | null,
): Promise<Pick<SandboxHandle, "network" | "allowedHosts"> | null> {
  const [profile] = profileId
    ? await ctx.db
        .select({ cli: agentProfiles.cli, model: agentProfiles.model })
        .from(agentProfiles)
        .where(eq(agentProfiles.id, profileId))
        .limit(1)
    : [];
  if (profile) {
    return modalNetworkForProject(ctx, swarm.projectId, swarm.organizationId, profile.cli, profile.model);
  }
  return (await organizationRestrictsNetwork(ctx, swarm.organizationId)) ? null : {};
}

/** A tag that can be compared with a uuid column. A swarm's is its workspace key, which cannot. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Running Modal sandboxes with no live row.
 *
 * A destroyed row does not count as live: the name can be reused, and
 * a machine still up under it is being billed with nobody looking.
 * The row is matched by the machine's name, so a swarm sandbox is
 * kept the same way a card's is.
 *
 * Each machine is its own attempt. A swarm's tag is `swarm-<id>`, and
 * comparing that with the feature id column threw, which ended the
 * sweep at the first swarm machine and the nightly job with it, before
 * it reached the swarm reaper. One machine that cannot be judged is
 * logged and the rest still are.
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
    try {
      await sweepOrphanModalSandbox(ctx, driver, item, featureId);
    } catch (err) {
      console.warn(`could not sweep Modal sandbox ${item.externalId}:`, err);
      ctx.analytics?.captureException(err, null, null, {
        source: "modal_sweep",
        sandbox: item.externalId,
      });
    }
  }
}

/** One machine of the sweep: destroyed only when nothing live points at it. */
async function sweepOrphanModalSandbox(
  ctx: AppContext,
  driver: ModalDriver,
  item: { externalId: string; tags: Record<string, string> },
  featureId: string,
): Promise<void> {
  if (UUID.test(featureId)) {
    const [activeRun] = await ctx.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (activeRun) return;
  }
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
  if (activeOnMachine) return;
  const created = Number(item.tags.bento_created ?? "0");
  if (Number.isFinite(created) && created > 0 && Date.now() - created < MODAL_SWEEP_GRACE_MS) return;
  const [live] = await ctx.db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(and(eq(sandboxes.externalId, item.externalId), ne(sandboxes.status, "destroyed")))
    .limit(1);
  if (live) return;
  await driver.destroy({
    externalId: item.externalId,
    provider: "modal",
    workdir: "/workspace",
  });
  console.log(`destroyed orphan Modal sandbox ${item.externalId}`);
}
