import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { agentRuns, features, repositories, sandboxes, swarmLandings, swarmTasks, swarms } from "@bento/db";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { LANDING_ACTIVITY_MAX_MS, sweepOrphanModalSandboxes } from "./hibernate-sandbox.js";
import { driverForSandbox, SandboxDriverUnavailable } from "./sandbox-driver.js";
import { ACTIVE_RUN_STATUSES } from "./start-run.js";
import { swarmTaskWorkspaceKey } from "./swarm/sandbox.js";
import { archiveReapsSandboxes } from "./swarm/archive.js";
import { swarmReleasesMachine } from "./swarm/coordinator.js";

const execFileAsync = promisify(execFile);

/** The queue a finished card's sandbox goes through on its way out. */
export const REAP_SANDBOX_QUEUE = "sandbox.reap";

/**
 * How long a reap waits when an agent is still in the machine.
 *
 * Long enough that a planner turn does not ask again on every poll,
 * and short enough that a machine whose run just ended is not left
 * billing for the afternoon if the tick that would have asked again
 * never arrives.
 */
export const SANDBOX_REAP_DEFER_MS = 30_000;

/**
 * How many times one reap job waits before it fails instead.
 *
 * Two hours of thirty second waits. A run that is still active after
 * that is not an agent finishing a long turn, it is a run row stuck
 * in an active status, and a job that waited for it forever would be
 * a job a minute with nothing in error tracking. The failure is
 * recorded once, the way any other reap failure is, and the boot
 * sweep finds the machine again.
 */
export const MAX_SANDBOX_REAP_DEFERRALS = 240;

/** Which machine a reap job is about. A job names exactly one of these. */
export interface SandboxReapTarget {
  featureId?: string;
  swarmId?: string;
  swarmTaskId?: string;
  /** How many times this job has already waited for an agent to finish. */
  deferrals?: number;
}

/**
 * An agent is still using this machine, so the reap has to wait.
 *
 * This is a control path, not a failure. The machine stays, and the
 * job is asked again later: skipping would drop the only reference to
 * it, and failing the job is what error tracking records and what the
 * queue gives up on after a few tries. A planner turn lasts longer
 * than those tries. Callers that are a person (releasing a branch)
 * still surface the message. Callers that are the queue reschedule.
 */
export class SandboxReapDeferred extends Error {
  readonly reap: SandboxReapTarget;

  constructor(message: string, reap: SandboxReapTarget) {
    super(message);
    this.name = "SandboxReapDeferred";
    this.reap = reap;
  }
}

/** Puts the same reap back on the queue once an agent may have finished, counting the wait. */
export async function rescheduleSandboxReap(
  ctx: AppContext,
  deferred: SandboxReapDeferred,
  deferrals: number,
): Promise<void> {
  console.log(`${deferred.message}; asking again later (${deferrals} of ${MAX_SANDBOX_REAP_DEFERRALS})`);
  await ctx.jobs.send(
    REAP_SANDBOX_QUEUE,
    { ...deferred.reap, deferrals },
    { delayMs: SANDBOX_REAP_DEFER_MS },
  );
}

/**
 * A card's workspace directory, which is its feature id.
 *
 * Not every directory under worktrees/ is one any more: a swarm's is
 * its workspace key, `swarm-<id>`, which this deliberately does not
 * match. The sweep below deletes a directory whose row it cannot find,
 * so a pattern that accepted a swarm's name would look it up in
 * features, find nothing, and delete the workspace of a swarm that is
 * still working. Anything that widens this has to answer that first.
 */
const FEATURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Asks for a card's sandbox to be destroyed.
 *
 * Queued rather than done inline: destroying a sprite is a network
 * call to another provider, and a card should not fail to finish
 * because Fly was slow. A job retries; a click does not.
 */
export async function queueSandboxReap(ctx: AppContext, featureId: string): Promise<void> {
  await ctx.jobs.send(REAP_SANDBOX_QUEUE, { featureId });
}

/** The same request for a swarm that is over, through the same queue. */
export async function queueSwarmSandboxReap(ctx: AppContext, swarmId: string): Promise<void> {
  await ctx.jobs.send(REAP_SANDBOX_QUEUE, { swarmId });
}

/** A swarm this reaper treats as over: nothing of it will run again. */
const FINISHED_SWARM_STATUSES = ["done", "cancelled"] as const;

/**
 * Endings a person can still pick up: a failed swarm by retrying a
 * leaf or a landing, one out of budget or time by raising the ceiling.
 */
const RESUMABLE_SWARM_ENDINGS = ["failed", "budget_exhausted", "timed_out"] as const;

/**
 * How long a swarm that ended without finishing keeps its machine with
 * nobody touching it.
 *
 * A failed swarm is not over: a person retries a leaf or a landing on
 * it, and one that ran out of budget or time resumes when the ceiling
 * is raised. Its machine holds the swarm's branch, and GitHub has a
 * copy only when the project is connected and every push went through.
 * Reaping it with the others (this sweep did, on every boot) made the
 * retry land onto nothing. A week untouched is a swarm nobody is
 * coming back to, and a sprite bills its storage for as long as it
 * exists, so it goes then.
 */
export const FAILED_SWARM_MACHINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Asks for the machine one swarm leaf was worked on to be destroyed.
 *
 * A swarm is the case a card never was: one goal can be five machines,
 * and they are not five machines one after another but five at once. A
 * leaf whose branch has landed is finished with forever (its branch is
 * on the swarm's branch and its worker will not be resumed), so the
 * machine is pure cost from that moment, and a swarm of fifty leaves
 * that kept them all would be fifty sprites billed by the gigabyte
 * month for a goal that finished on Tuesday.
 *
 * Keyed by the task rather than by the swarm, because the swarm's own
 * machine is where the planner and the merge queue live and must
 * outlive every leaf.
 */
export async function queueSwarmTaskSandboxReap(ctx: AppContext, swarmTaskId: string): Promise<void> {
  await ctx.jobs.send(REAP_SANDBOX_QUEUE, { swarmTaskId });
}

/**
 * Destroys the sandbox belonging to a card that is over, and in local
 * mode the host workspace that container was bind-mounting.
 *
 * A sandbox is a machine somebody is paying for by the gigabyte month,
 * for as long as it exists, whether or not it ever wakes again. Fly
 * bills storage on every sprite that has not been destroyed, so a card
 * that finished in March is still on the April invoice, and still on
 * next year's, and goes on being charged after the customer has left.
 * The workspace is the local-mode equivalent: worktrees plus leftover
 * node_modules sitting under BENTO_DATA_DIR until something deletes
 * them. Artifacts are not here; they live in Postgres and the artifact
 * store, and nothing in this function touches either.
 *
 * Deliberately not gentle about verification. `destroy` is best effort
 * on every driver, so believing it would let one unreachable API call
 * mark a machine gone while it goes on billing, which is the exact
 * failure this exists to prevent. The row is only marked destroyed
 * once the driver has been asked again and said the machine is gone.
 */
export async function reapSandbox(ctx: AppContext, featureId: string): Promise<void> {
  /**
   * A card is not supposed to finish with an agent still working it,
   * but the gate evaluator and a manual start can race, and killing a
   * sandbox out from under a running agent would leave the branch in a
   * state nobody chose. Throwing SandboxReapDeferred rather than
   * skipping, so the job comes back later: skipping would drop the
   * only reference to this machine and leak it for good. Checked
   * before looking at sandbox rows: a
   * card whose provisioning failed has worktrees but may have no
   * machine, and those still must not vanish under a live agent.
   */
  const [working] = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, featureId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .limit(1);
  if (working) {
    throw new SandboxReapDeferred(`a run is still working feature ${featureId}; not reaping its sandbox yet`, {
      featureId,
    });
  }

  const rows = await ctx.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.featureId, featureId), ne(sandboxes.status, "destroyed")));

  /**
   * Every row, not the first one.
   *
   * A card holds one machine at a time, but not necessarily the same
   * one for its whole life: the Docker driver rebuilds a container
   * when the mounts it was built for stop being the truth, and the new
   * one has a new id. Reaping a single row left the earlier machines
   * with nothing pointing at them.
   */
  for (const row of rows) {
    let driver: SandboxDriver;
    try {
      driver = driverForSandbox(ctx.drivers, row);
    } catch (err) {
      if (!(err instanceof SandboxDriverUnavailable)) throw err;
      // Permanent: this process cannot delete the machine, so the row
      // stays. Marking it destroyed would hide a machine that is still
      // billing. Later rows, and the host workspace below, still go.
      // Retrying the job would throw the same way.
      console.warn(`not reaping sandbox ${row.externalId} for feature ${featureId}: ${err.message}`);
      continue;
    }
    const handle = {
      externalId: row.externalId,
      provider: driver.provider,
      workdir: row.workdir,
      ...(row.imageRef ? { imageRef: row.imageRef } : {}),
    };
    await driver.destroy(handle);

    // Drivers that can answer are asked. One that cannot is taken at
    // its word, which is right for the local ones: a container on
    // somebody's laptop bills nobody, so there is no leak to be
    // careful about.
    if (driver.exists && (await driver.exists(handle))) {
      throw new Error(`sandbox ${row.externalId} is still there after being destroyed; will retry`);
    }

    await ctx.db.update(sandboxes).set({ status: "destroyed" }).where(eq(sandboxes.id, row.id));
    console.log(`reaped sandbox ${row.externalId} for finished feature ${featureId}`);
  }

  await removeFeatureWorkspace(ctx, featureId);
}

/**
 * Destroys the machine a swarm itself holds, once the swarm is over.
 *
 * A swarm's own sprite is the one its planner and its coordinator work
 * in, and it is the longest lived machine in the product: it is
 * provisioned before the plan exists and it is still there when the
 * last leaf lands. Nothing but DELETE /swarms/:id used to take it, so
 * a swarm somebody finished or stopped went on being billed by the
 * gigabyte month for as long as the account existed, which is the
 * exact failure the card reaper was written for.
 *
 * The swarm's own machine only: a leaf's worker machine names its task
 * as well, and reaping those belongs with the code that starts them.
 * The card path is untouched, and a swarm's rows never reach it (a
 * swarm machine's feature_id is null, which is why the sweep below
 * missed all of them).
 *
 * The swarm is read again, under its lock, before anything goes. A
 * reap is queued when the swarm ends and runs whenever the queue gets
 * to it, and a swarm can be live again by then: production queued one
 * when a worker's failure briefly failed a swarm, a person retried it,
 * and the job destroyed the running swarm's sprite a second after the
 * planner's run ended, with the two tasks that had landed on its
 * branch. A swarm that is live again keeps its machine and the job
 * ends quietly, because that is the job being right, not failing. The
 * lock is the one a retry, a resume and a run start take, held until
 * the rows say destroyed, so none of them can bring the swarm back in
 * between.
 *
 * Deliberately not gentle about verification, and refusing while an
 * agent or a landing is still at work: both for the reasons reapSandbox
 * states.
 */
export async function reapSwarmSandbox(
  ctx: AppContext,
  swarmId: string,
  options: { now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await ctx.db.transaction(async (tx) => {
    const swarm = await lockSwarmForReap(tx, swarmId);
    if (!swarmMachineReleasable(swarm, now)) {
      console.log(`swarm ${swarmId} is ${swarm?.status} and not archived; keeping its sandbox`);
      return;
    }

    const [working] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.swarmId, swarmId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (working) {
      throw new SandboxReapDeferred(`a run is still working swarm ${swarmId}; not reaping its sandbox yet`, {
        swarmId,
      });
    }
    /*
     * A landing being performed imports into this machine and runs the
     * swarm's checks there. Bounded the way hibernation bounds it: a
     * row whose job died says "landing" forever, and past that it is
     * not holding anybody's machine.
     */
    const [landing] = await tx
      .select({ id: swarmLandings.id })
      .from(swarmLandings)
      .where(
        and(
          eq(swarmLandings.swarmId, swarmId),
          eq(swarmLandings.status, "landing"),
          gt(swarmLandings.startedAt, new Date(now.getTime() - LANDING_ACTIVITY_MAX_MS)),
        ),
      )
      .limit(1);
    if (landing) {
      throw new SandboxReapDeferred(`a landing is in progress on swarm ${swarmId}; not reaping its sandbox yet`, {
        swarmId,
      });
    }

    const rows = await tx
      .select()
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.swarmId, swarmId),
          isNull(sandboxes.swarmTaskId),
          ne(sandboxes.status, "destroyed"),
        ),
      );

    for (const row of rows) {
      if (!(await destroyAndConfirm(ctx, row, `swarm ${swarmId}`))) continue;
      await tx.update(sandboxes).set({ status: "destroyed" }).where(eq(sandboxes.id, row.id));
      console.log(`reaped sandbox ${row.externalId} for finished swarm ${swarmId}`);
    }
  });
}

/**
 * Asks the driver to destroy one machine and to say it is gone.
 *
 * False when this process has no driver for the row's provider: the
 * row stays, because marking it destroyed would hide a machine that
 * is still billing, and the caller moves on to the rest. Throws when
 * the machine is still there afterwards, so the job retries.
 *
 * The handle carries the row's image. Modal's destroy deletes the
 * hibernation image only when it is named, and that image bills for up
 * to thirty days; Modal's exists also answers for a hibernated machine
 * only through it, so without it a reap called a machine gone while
 * its image was still stored.
 */
async function destroyAndConfirm(
  ctx: AppContext,
  row: typeof sandboxes.$inferSelect,
  owner: string,
): Promise<boolean> {
  let driver: SandboxDriver;
  try {
    driver = driverForSandbox(ctx.drivers, row);
  } catch (err) {
    if (!(err instanceof SandboxDriverUnavailable)) throw err;
    console.warn(`not reaping sandbox ${row.externalId} for ${owner}: ${err.message}`);
    return false;
  }
  const handle = {
    externalId: row.externalId,
    provider: driver.provider,
    workdir: row.workdir,
    ...(row.imageRef ? { imageRef: row.imageRef } : {}),
  };
  await driver.destroy(handle);
  if (driver.exists && (await driver.exists(handle))) {
    throw new Error(`sandbox ${row.externalId} is still there after being destroyed; will retry`);
  }
  return true;
}

/** How long a reap waits for the swarm's lock before reading the row as committed. */
const SWARM_REAP_LOCK_TIMEOUT = "5s";

/** Anything that can run a query inside the reap's transaction. */
type ReapTx = Parameters<Parameters<AppContext["db"]["transaction"]>[0]>[0];

/**
 * The swarm, locked for the rest of the reap's transaction. Undefined
 * when it was deleted.
 *
 * The lock is waited for only so long. The branch release route holds
 * this row locked in its own transaction while it calls the reap, and
 * a reap that waited for it without end would wait for itself. Past
 * the timeout the row is read as committed, which is what that route
 * has already checked under its lock. The wait is a savepoint, so a
 * timeout does not abort the transaction around it.
 */
async function lockSwarmForReap(
  tx: ReapTx,
  swarmId: string,
): Promise<Pick<typeof swarms.$inferSelect, "status" | "archivedAt" | "updatedAt"> | undefined> {
  const columns = { status: swarms.status, archivedAt: swarms.archivedAt, updatedAt: swarms.updatedAt };
  try {
    return await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql.raw(`set local lock_timeout = '${SWARM_REAP_LOCK_TIMEOUT}'`));
      const [row] = await savepoint.select(columns).from(swarms).where(eq(swarms.id, swarmId)).for("update");
      await savepoint.execute(sql`set local lock_timeout = 0`);
      return row;
    });
  } catch (err) {
    if (!isLockNotAvailable(err)) throw err;
    console.warn(`swarm ${swarmId} stayed locked; reading it as committed for its reap`);
    const [row] = await tx.select(columns).from(swarms).where(eq(swarms.id, swarmId)).limit(1);
    return row;
  }
}

/** Postgres's lock_not_available, wherever the driver and drizzle put it on the cause chain. */
function isLockNotAvailable(err: unknown): boolean {
  for (let e: unknown = err; typeof e === "object" && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "55P03") return true;
  }
  return false;
}

/**
 * Whether a swarm's own machine may be destroyed, read from the swarm
 * as it is now.
 *
 * A deleted swarm has nobody to keep it for. A done or cancelled one
 * is finished with it (swarmReleasesMachine). An ending a person can
 * still pick up (failed, out of budget, out of time) keeps it, unless
 * the swarm was archived or has sat untouched past
 * FAILED_SWARM_MACHINE_GRACE_MS. Anything else is a swarm that is live,
 * or live again, and its machine holds its branch.
 */
export function swarmMachineReleasable(
  swarm: Pick<typeof swarms.$inferSelect, "status" | "archivedAt" | "updatedAt"> | undefined,
  now: Date = new Date(),
): boolean {
  if (!swarm) return true;
  if (swarmReleasesMachine(swarm.status)) return true;
  if (!(RESUMABLE_SWARM_ENDINGS as readonly string[]).includes(swarm.status)) return false;
  if (swarm.archivedAt && archiveReapsSandboxes(swarm)) return true;
  return swarm.updatedAt.getTime() < now.getTime() - FAILED_SWARM_MACHINE_GRACE_MS;
}

/**
 * The sweep for the swarms, which the card query cannot see: a
 * swarm's machine has no feature_id, so an inner join on features
 * matched none of them and every finished swarm's machine was left
 * running. Its own query rather than a widened one, because the two
 * boards say "over" with different words in different tables.
 *
 * Done and cancelled swarms at once; one that failed or ran out of
 * budget or time only once it has sat untouched past
 * FAILED_SWARM_MACHINE_GRACE_MS. Run at boot and by the nightly sweep,
 * so the grace ends even on a server nobody redeploys. The query only
 * nominates: reapSwarmSandbox reads each swarm again under its lock.
 */
export async function reapFinishedSwarmSandboxes(ctx: AppContext, now: Date = new Date()): Promise<void> {
  const abandonedBefore = new Date(now.getTime() - FAILED_SWARM_MACHINE_GRACE_MS);
  const staleSwarms = await ctx.db
    .select({ swarmId: sandboxes.swarmId })
    .from(sandboxes)
    .innerJoin(swarms, eq(swarms.id, sandboxes.swarmId))
    .where(
      and(
        ne(sandboxes.status, "destroyed"),
        isNull(sandboxes.swarmTaskId),
        or(
          inArray(swarms.status, [...FINISHED_SWARM_STATUSES]),
          and(inArray(swarms.status, [...RESUMABLE_SWARM_ENDINGS]), lt(swarms.updatedAt, abandonedBefore)),
        ),
      ),
    );
  for (const swarmId of new Set(staleSwarms.map((row) => row.swarmId))) {
    if (!swarmId) continue;
    try {
      await sweepReap(ctx, { swarmId }, now);
    } catch (err) {
      console.warn(`could not reap the sandbox for swarm ${swarmId}:`, err);
      ctx.analytics?.captureException(err, null, null, { swarm_id: swarmId, source: "sandbox_reap" });
    }
  }
}

/**
 * Drops the card's host workspace. Sprite deployments never create
 * one, so the removal is a no-op there; a deployment that switched
 * drivers mid-card still gets cleaned.
 */
async function removeFeatureWorkspace(ctx: AppContext, featureId: string): Promise<void> {
  const [feature] = await ctx.db
    .select({ projectId: features.projectId })
    .from(features)
    .where(eq(features.id, featureId))
    .limit(1);
  if (!feature) {
    await ctx.worktrees.removeWorkspace([], featureId);
    return;
  }
  const repos = await ctx.db
    .select({ name: repositories.name, localPath: repositories.localPath })
    .from(repositories)
    .where(eq(repositories.projectId, feature.projectId));
  await ctx.worktrees.removeWorkspace(repos, featureId);
}

/**
 * Destroys the machine one swarm leaf was worked on, and the host
 * workspace it was bind-mounting.
 *
 * Deliberately the same shape as reapSandbox, and deliberately not the
 * same function. What they share is the careful part: refusing while an
 * agent is still working, taking every row rather than the first, and
 * only marking a row destroyed once the driver has been asked again
 * and said the machine is gone. What they do not share is what a
 * machine belongs to, and a single function taking either would have
 * had to guess which column a null meant.
 */
export async function reapSwarmTaskSandbox(ctx: AppContext, swarmTaskId: string): Promise<void> {
  /**
   * Never under a live agent. A leaf that landed should have no run on
   * it, but a resolver started for its conflict and a worker the
   * planner reassigned are both real, and killing a machine out from
   * under either leaves a branch in a state nobody chose. Throwing
   * SandboxReapDeferred rather than skipping, so the job comes back
   * later: skipping would drop the only reference to this machine and
   * leak it for good.
   */
  const [working] = await ctx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.swarmTaskId, swarmTaskId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    .limit(1);
  if (working) {
    throw new SandboxReapDeferred(
      `a run is still working swarm task ${swarmTaskId}; not reaping its sandbox yet`,
      { swarmTaskId },
    );
  }

  const rows = await ctx.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.swarmTaskId, swarmTaskId), ne(sandboxes.status, "destroyed")));

  for (const row of rows) {
    if (!(await destroyAndConfirm(ctx, row, `swarm task ${swarmTaskId}`))) continue;
    await ctx.db.update(sandboxes).set({ status: "destroyed" }).where(eq(sandboxes.id, row.id));
    console.log(`reaped sandbox ${row.externalId} for finished swarm task ${swarmTaskId}`);
  }

  await removeSwarmTaskWorkspace(ctx, swarmTaskId);
}

/**
 * Throws away everything a leaf's earlier attempts left, so the next
 * agent on it starts over from the swarm's branch in a new machine.
 *
 * The machine goes through the leaf's own reap, which refuses while an
 * agent is still in it (stop the runs first) and only marks the row
 * destroyed once the driver says the machine is gone. A clone driver's
 * branch lived only in that machine. A host driver's branch outlives
 * its worktree in the project's checkout, and the next worktree would
 * check that branch out again with the old commits on it, so it is
 * deleted there too. A branch that is not there is already what this
 * wants.
 */
export async function discardSwarmTaskWork(
  ctx: AppContext,
  input: { swarmTaskId: string; branch: string | null },
): Promise<void> {
  await reapSwarmTaskSandbox(ctx, input.swarmTaskId);
  if (!input.branch) return;
  const [task] = await ctx.db
    .select({ projectId: swarms.projectId })
    .from(swarmTasks)
    .innerJoin(swarms, eq(swarms.id, swarmTasks.swarmId))
    .where(eq(swarmTasks.id, input.swarmTaskId))
    .limit(1);
  if (!task) return;
  const repos = await ctx.db
    .select({ localPath: repositories.localPath })
    .from(repositories)
    .where(eq(repositories.projectId, task.projectId));
  for (const repo of repos) {
    if (!repo.localPath) continue;
    try {
      await execFileAsync("git", ["-C", repo.localPath, "branch", "-D", input.branch]);
    } catch {
      // Not a checkout on this host, or no such branch: nothing to remove.
    }
  }
}

/**
 * Drops the leaf's host workspace.
 *
 * The workspace key is rebuilt from the swarm and the task rather than
 * read off a row, for the reason the swarm's own key is: it is derived
 * from ids that never change, and a name rebuilt from a slug a team
 * may have renamed would point at a directory that is not this one.
 */
async function removeSwarmTaskWorkspace(ctx: AppContext, swarmTaskId: string): Promise<void> {
  const [task] = await ctx.db
    .select({ swarmId: swarmTasks.swarmId })
    .from(swarmTasks)
    .where(eq(swarmTasks.id, swarmTaskId))
    .limit(1);
  if (!task) return;
  const [swarm] = await ctx.db
    .select({ projectId: swarms.projectId })
    .from(swarms)
    .where(eq(swarms.id, task.swarmId))
    .limit(1);
  const key = swarmTaskWorkspaceKey(task.swarmId, swarmTaskId);
  if (!swarm) {
    await ctx.worktrees.removeWorkspace([], key);
    return;
  }
  const repos = await ctx.db
    .select({ name: repositories.name, localPath: repositories.localPath })
    .from(repositories)
    .where(eq(repositories.projectId, swarm.projectId));
  await ctx.worktrees.removeWorkspace(repos, key);
}

/**
 * One reap job.
 *
 * A run that is still working is not a failed job. The queue's error
 * wrapper reports every throw, and a throw is also what the queue
 * gives up on after a few retries, which is sooner than an agent
 * finishes. Asking again later keeps the machine and stays quiet,
 * up to MAX_SANDBOX_REAP_DEFERRALS; past that the wait is the
 * failure it has become. Anything else still fails the job, so a
 * machine the driver could not destroy is retried and recorded.
 */
export async function runSandboxReapJob(ctx: AppContext, data: SandboxReapTarget): Promise<void> {
  try {
    await reapTarget(ctx, data);
  } catch (err) {
    if (!(err instanceof SandboxReapDeferred)) throw err;
    const deferrals = (data.deferrals ?? 0) + 1;
    if (deferrals > MAX_SANDBOX_REAP_DEFERRALS) throw err;
    await rescheduleSandboxReap(ctx, err, deferrals);
  }
}

/** One reap, whichever machine the target names. */
async function reapTarget(ctx: AppContext, data: SandboxReapTarget, now?: Date): Promise<void> {
  // The leaf is asked first because it is the narrowest. A target
  // naming none of them is one nothing can act on, so it is dropped
  // rather than retried forever.
  if (data.swarmTaskId) await reapSwarmTaskSandbox(ctx, data.swarmTaskId);
  else if (data.swarmId) await reapSwarmSandbox(ctx, data.swarmId, now ? { now } : {});
  else if (data.featureId) await reapSandbox(ctx, data.featureId);
}

/**
 * The sweep's reap: a machine an agent is still in is left for the
 * next sweep, or for its owner's own settlement, which asks for it
 * once nothing is running. Not rescheduled, because every boot would
 * start another chain of waits for the same machine beside the one
 * the queue may already hold.
 */
async function sweepReap(ctx: AppContext, data: SandboxReapTarget, now?: Date): Promise<void> {
  try {
    await reapTarget(ctx, data, now);
  } catch (err) {
    if (!(err instanceof SandboxReapDeferred)) throw err;
    console.log(`${err.message}; the next sweep will ask again`);
  }
}

/**
 * Sweeps up sandboxes belonging to cards that finished before this
 * existed, and any the queue lost, plus leftover host workspaces the
 * machine pass cannot see.
 *
 * A job that failed every retry leaves a machine nobody is looking for,
 * and the first run of this on an existing deployment is the only thing
 * that will ever reclaim the cards finished up to now. Workspaces of
 * cards whose machines were already marked destroyed (or never
 * provisioned) are the same story: only this pass will ever take them.
 */
export async function reapFinishedSandboxes(ctx: AppContext): Promise<void> {
  const stale = await ctx.db
    .select({ featureId: sandboxes.featureId })
    .from(sandboxes)
    .innerJoin(features, eq(features.id, sandboxes.featureId))
    .where(and(ne(sandboxes.status, "destroyed"), inArray(features.status, ["done", "cancelled"])));

  // Distinct: reapSandbox takes every row a card holds, so a card with
  // more than one would otherwise be visited once per row and do
  // nothing on all but the first.
  for (const featureId of new Set(stale.map((row) => row.featureId))) {
    if (!featureId) continue;
    try {
      await sweepReap(ctx, { featureId });
    } catch (err) {
      // One machine that will not go must not stop the rest going.
      // A run still working is not this case: the sweep leaves it for
      // the next pass, and recording that wait is how a live agent
      // became an error.
      console.warn(`could not reap the sandbox for feature ${featureId}:`, err);
      ctx.analytics?.captureException(err, null, null, { feature_id: featureId, source: "sandbox_reap" });
    }
  }

  await reapFinishedSwarmSandboxes(ctx);

  const worktreesRoot = path.join(ctx.env.BENTO_DATA_DIR, "worktrees");
  let entries;
  try {
    entries = await readdir(worktreesRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !FEATURE_ID.test(entry.name)) continue;
    const featureId = entry.name;
    try {
      const [feature] = await ctx.db
        .select({ status: features.status })
        .from(features)
        .where(eq(features.id, featureId))
        .limit(1);
      if (!feature) {
        await ctx.worktrees.removeWorkspace([], featureId);
        continue;
      }
      if (feature.status !== "done" && feature.status !== "cancelled") continue;
      await sweepReap(ctx, { featureId });
    } catch (err) {
      console.warn(`could not reap the workspace for feature ${featureId}:`, err);
      ctx.analytics?.captureException(err, null, null, { feature_id: featureId, source: "sandbox_reap" });
    }
  }

  // Modal machines with no live row are not in the query above. The
  // same pass, and the nightly job, terminate those.
  await sweepOrphanModalSandboxes(ctx);
}
