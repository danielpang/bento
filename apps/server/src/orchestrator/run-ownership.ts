import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { agentRuns } from "@bento/db";
import type { AppContext, RunOwnership } from "../context.js";
import type { RunControl } from "../events.js";

/**
 * Which process drives a run, decided by a lease rather than by a name.
 *
 * A run's agent stream, abort handle and stdin live in exactly one
 * server process. With one machine that was a fact; with Fly starting a
 * second machine on web traffic it became a race. Boot recovery used to
 * reattach to every server run that said "running", so a machine
 * booting beside a live one took over runs the live one was still
 * driving: two loops on one agent, two writers on one transcript, two
 * owners of one stdin. And every door that reaches into a run (cancel,
 * a message into a live session) looked only in its own memory.
 *
 * The answer is the one every multi-node chat server uses: ownership
 * is a lease, and requests are routed to the holder over pub/sub.
 *
 * - Each process mints an id at boot (`instanceId`). Deliberately not
 *   the machine id. Fly destroys and recreates machines, a suspended
 *   machine comes back hours later with the same id and a dead
 *   claim, and a process that lost its runs must not be able to find
 *   them again by name. A fresh uuid per boot has none of those paths.
 * - A process stamps `owner_id` as it claims a run (the queue claim,
 *   or an adoption), and renews `owner_heartbeat_at` for every run it
 *   holds, every RUN_HEARTBEAT_MS, in one statement.
 * - A run whose stamp is older than RUN_LEASE_MS has nobody behind it:
 *   the process died, was suspended, or cannot reach the database, and
 *   in all three it is not writing. Any live server may adopt it
 *   (`adoptOrphanedRuns`), with a compare and set on the stale lease so
 *   two servers cannot both win, and then reattach to the agent still
 *   working in its sandbox exactly as a boot always has.
 * - A process that notices its lease was taken (the heartbeat renews
 *   fewer rows than it holds) disowns the run: it keeps consuming the
 *   stream so the socket does not drop the agent, but writes nothing
 *   and ends nothing, the way a draining process already treats all of
 *   its runs. The transcript insert carries the same guard, so even a
 *   write racing the heartbeat is refused by the database rather than
 *   landing beside the new owner's.
 * - Routes that need the holder publish a `run_control` on the bus
 *   (events.ts). Every process hears it; the one with the run in memory
 *   acts; the rest ignore it.
 *
 * Shutdown releases every held run and announces it, so the successor
 * adopts at once instead of waiting out a lease. Nothing here waits on
 * a message that may never come: the release is a fast path, and the
 * reap schedule's sweep is what finds a run whose holder simply went
 * away.
 */

/** How often a process renews the lease on the runs it holds. */
export const RUN_HEARTBEAT_MS = 20_000;

/**
 * How stale a heartbeat may be before the run is nobody's. Several
 * heartbeats, so one slow query or a short event loop stall never
 * costs a process its runs, and short enough that a suspended machine's
 * runs are picked up within the reap schedule's next pass.
 */
export const RUN_LEASE_MS = 90_000;

/** The statuses a process holds a run in. Queued is nobody's yet. */
const HELD_STATUSES = ["starting", "running"] as const;

export function ownershipOf(ctx: AppContext): RunOwnership {
  ctx.ownership ??= {
    instanceId: randomUUID(),
    owned: new Set(),
    disowned: new Set(),
    onDisown: new Map(),
  };
  return ctx.ownership;
}

/**
 * Whether this process may still write for the run. False while the
 * process drains (its successor has every run) and for a run this
 * process was disowned of. Every executor path that would write a
 * transcript line, end a run or deliver a message asks this first.
 */
export function yielded(ctx: AppContext, runId: string): boolean {
  return ctx.draining || ctx.ownership?.disowned.has(runId) === true;
}

/**
 * The columns a claim writes. Spread into the claim's own compare and
 * set rather than written after it, so there is no instant in which a
 * run is starting with nobody's name on it.
 */
export function ownershipClaim(ctx: AppContext): { ownerId: string; ownerHeartbeatAt: Date } {
  return { ownerId: ownershipOf(ctx).instanceId, ownerHeartbeatAt: new Date() };
}

/**
 * Records that this process now drives the run. Called beside the
 * claim's compare and set, and by adoption. Starts the heartbeat if
 * this is the first run held.
 */
export function holdRun(ctx: AppContext, runId: string): void {
  const ownership = ownershipOf(ctx);
  ownership.disowned.delete(runId);
  ownership.owned.add(runId);
  ensureHeartbeat(ctx);
}

/**
 * Forgets a run this process drove to its end, or stopped driving. The
 * row's columns are left as they are: a terminal status is what says
 * the run is over, and a stale owner on a finished row is history.
 */
export function releaseRun(ctx: AppContext, runId: string): void {
  const ownership = ctx.ownership;
  if (!ownership) return;
  ownership.owned.delete(runId);
  ownership.disowned.delete(runId);
  ownership.onDisown.delete(runId);
  if (ownership.owned.size === 0) stopHeartbeat(ctx);
}

/**
 * The row condition "still mine or nobody's". Nobody's covers rows from
 * before the column, runner-executed runs, and a run its process let go
 * on shutdown, every one of which every process could write before this
 * existed.
 */
export function ownedByMeOrNobody(ctx: AppContext): SQL {
  return or(isNull(agentRuns.ownerId), eq(agentRuns.ownerId, ownershipOf(ctx).instanceId))!;
}

/**
 * Stops writing for a run another process now owns. The stream is left
 * running: closing it could tear down the agent's exec session, and the
 * process that owns the run now is attached to the same session. Hold
 * timers are cleared so this side never closes stdin under the owner.
 */
export function disownRun(ctx: AppContext, runId: string): void {
  const ownership = ownershipOf(ctx);
  if (!ownership.owned.has(runId) && ownership.disowned.has(runId)) return;
  ownership.owned.delete(runId);
  ownership.disowned.add(runId);
  // Nothing here may reach the agent any more: not a message, and not
  // a cancel either, which is the new owner's to carry out.
  ctx.liveInputs.delete(runId);
  ctx.running.delete(runId);
  const hook = ownership.onDisown.get(runId);
  ownership.onDisown.delete(runId);
  try {
    hook?.();
  } catch (err) {
    console.warn(`could not let go of run ${runId} cleanly:`, err);
  }
  console.warn(`run ${runId} is now driven by another server; this process stops writing for it`);
  if (ownership.owned.size === 0) stopHeartbeat(ctx);
}

/**
 * Whether this process may still end a run's stdin, asked of the row at
 * the moment it matters rather than of memory.
 *
 * A live session's hold timer closes stdin when it fires. A machine
 * suspended past its lease resumes with that timer overdue, and it
 * fires before the heartbeat has had a chance to notice the run was
 * adopted meanwhile; the EOF would end the agent under its new owner.
 * The same gap exists for a draining process whose successor already
 * has the run. So the timer asks here first. A row that names another
 * process disowns the run on the spot. A read that fails answers no:
 * the cost of not closing is a session held until the run limit, the
 * cost of closing wrongly is another server's agent ended.
 */
export async function confirmRunOwnership(ctx: AppContext, runId: string): Promise<boolean> {
  if (yielded(ctx, runId)) return false;
  try {
    const [row] = await ctx.db
      .select({ ownerId: agentRuns.ownerId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!row) return false;
    if (row.ownerId === null || row.ownerId === ownershipOf(ctx).instanceId) return true;
    disownRun(ctx, runId);
    return false;
  } catch (err) {
    console.warn(`could not confirm who owns run ${runId}; leaving its stdin open:`, err);
    return false;
  }
}

/**
 * Closes the agent's stdin at the end of a loop, unless this process
 * was disowned of the run: the process that owns it now is attached to
 * the same session, and an EOF from here would end the agent under it.
 * A draining process still closes, as it always has, because its
 * stream only ends with the agent's exit.
 */
export function endStdinUnlessDisowned(ctx: AppContext, runId: string, channel: { end(): void } | null | undefined): void {
  if (ctx.ownership?.disowned.has(runId)) return;
  channel?.end();
}

/**
 * Renews the lease on every run this process holds, in one statement,
 * and disowns any it no longer owns. A run the statement did not renew
 * is either over (its loop released it meanwhile) or taken; the rows
 * say which.
 */
export async function heartbeatOwnedRuns(ctx: AppContext): Promise<{ renewed: string[]; disowned: string[] }> {
  const ownership = ctx.ownership;
  if (!ownership || ownership.owned.size === 0 || ctx.draining) return { renewed: [], disowned: [] };
  const held = [...ownership.owned];
  const renewed = await ctx.db
    .update(agentRuns)
    .set({ ownerHeartbeatAt: new Date() })
    .where(
      and(
        inArray(agentRuns.id, held),
        eq(agentRuns.ownerId, ownership.instanceId),
        inArray(agentRuns.status, [...HELD_STATUSES]),
      ),
    )
    .returning({ id: agentRuns.id });
  const renewedIds = new Set(renewed.map((row) => row.id));
  const missing = held.filter((id) => !renewedIds.has(id));
  const disowned: string[] = [];
  if (missing.length > 0) {
    const rows = await ctx.db
      .select({ id: agentRuns.id, ownerId: agentRuns.ownerId, status: agentRuns.status })
      .from(agentRuns)
      .where(inArray(agentRuns.id, missing));
    for (const row of rows) {
      // Taken: somebody else's name is on a run this process still
      // holds. A terminal status with this process's name is a loop
      // that finished between the heartbeat and this read, and a
      // deleted row is a run nobody will write again.
      if (row.ownerId !== null && row.ownerId !== ownership.instanceId && (HELD_STATUSES as readonly string[]).includes(row.status)) {
        disownRun(ctx, row.id);
        disowned.push(row.id);
      }
    }
  }
  return { renewed: [...renewedIds], disowned };
}

function ensureHeartbeat(ctx: AppContext): void {
  const ownership = ownershipOf(ctx);
  if (ownership.heartbeat) return;
  ownership.heartbeat = setInterval(() => {
    heartbeatOwnedRuns(ctx).catch((err: unknown) => {
      // One missed beat is inside the lease. Several in a row are the
      // database being unreachable, in which case the runs are about
      // to be somebody else's, and the next successful beat says so.
      console.warn("could not renew the lease on this server's runs:", err);
    });
  }, RUN_HEARTBEAT_MS);
  ownership.heartbeat.unref?.();
}

export function stopHeartbeat(ctx: AppContext): void {
  const ownership = ctx.ownership;
  if (!ownership?.heartbeat) return;
  clearInterval(ownership.heartbeat);
  delete ownership.heartbeat;
}

/**
 * Lets go of every run this process holds, for a shutdown: the columns
 * are cleared so the runs read as nobody's at once, and each is
 * announced so a live server adopts it now rather than when the lease
 * would have run out. Before the pool closes, because both the update
 * and the announcement need it.
 */
export async function releaseOwnedRuns(ctx: AppContext): Promise<string[]> {
  stopHeartbeat(ctx);
  const ownership = ctx.ownership;
  if (!ownership || ownership.owned.size === 0) return [];
  const released = await ctx.db
    .update(agentRuns)
    .set({ ownerId: null, ownerHeartbeatAt: null })
    .where(
      and(
        inArray(agentRuns.id, [...ownership.owned]),
        eq(agentRuns.ownerId, ownership.instanceId),
        inArray(agentRuns.status, [...HELD_STATUSES]),
      ),
    )
    .returning({ id: agentRuns.id });
  for (const row of released) ctx.bus.emitRunControl({ runId: row.id, action: "released" });
  ownership.owned.clear();
  return released.map((row) => row.id);
}

/**
 * Server runs nobody is driving: no owner on the row, or an owner whose
 * heartbeat is older than the lease. What boot recovery and the reap
 * sweep consider for adoption.
 */
export async function orphanedRuns(ctx: AppContext, leaseMs: number = RUN_LEASE_MS) {
  return ctx.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.executor, "server"),
        inArray(agentRuns.status, [...HELD_STATUSES]),
        or(
          isNull(agentRuns.ownerId),
          isNull(agentRuns.ownerHeartbeatAt),
          lt(agentRuns.ownerHeartbeatAt, sql`now() - make_interval(secs => ${leaseMs / 1000})`),
        ),
      ),
    );
}

/**
 * Takes a run nobody is driving. A compare and set on the very
 * condition that made it an orphan, so of two servers that saw the same
 * stale row exactly one comes back with it. The loser changes nothing
 * and does nothing further.
 */
export async function adoptRun(ctx: AppContext, runId: string, leaseMs: number = RUN_LEASE_MS): Promise<boolean> {
  const [adopted] = await ctx.db
    .update(agentRuns)
    .set(ownershipClaim(ctx))
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.executor, "server"),
        inArray(agentRuns.status, [...HELD_STATUSES]),
        or(
          isNull(agentRuns.ownerId),
          isNull(agentRuns.ownerHeartbeatAt),
          lt(agentRuns.ownerHeartbeatAt, sql`now() - make_interval(secs => ${leaseMs / 1000})`),
        ),
      ),
    )
    .returning({ id: agentRuns.id });
  if (!adopted) return false;
  holdRun(ctx, runId);
  return true;
}

/**
 * Runs an async task at most once at a time, with at most one more run
 * queued behind it. A server shutting down with thirty runs publishes
 * thirty releases, and every other process heard each one as a reason
 * to sweep for orphans: thirty sweeps where the first did all the work.
 * Through this, a burst becomes the sweep in flight and one more after
 * it, which is what confirms nothing arrived between the two.
 */
export function coalesced(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      await task();
    } while (again);
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  };
}

/**
 * Stops the agent of a run, wherever it is being driven. The local
 * abort covers a holder on this process without a round trip (and a
 * context that never attached a bus); the control covers every other
 * process. Routes have already marked the row, so the holder's loop
 * ends as a cancel.
 */
export function requestRunAbort(ctx: AppContext, runId: string): void {
  ctx.running.get(runId)?.abort();
  ctx.bus.emitRunControl({ runId, action: "cancel" });
}

/**
 * Tells whichever process holds the run that messages are parked for it
 * in the database. The caller has committed the rows; the holder claims
 * them through its live session's pump. Nothing happens for a run with
 * no live session, which is the parked message's ordinary fate: it
 * rides the next run.
 */
export function nudgeRun(ctx: AppContext, runId: string): void {
  ctx.bus.emitRunControl({ runId, action: "nudge" });
}

/**
 * What a process does with a control addressed to a run. Registered
 * once per process; a control for a run this process does not hold is
 * somebody else's and is ignored, except a release, which is an
 * invitation to every process.
 */
export interface RunControlDeps {
  /** Adopt whatever runs are nobody's; for a release. */
  adopt(): Promise<void>;
  /**
   * Run the swarm tick for a planner this process holds between turns;
   * for a tick that found news for it on another process. Only called
   * when the planner's live session says it is waiting.
   */
  tickHeldPlanner(runId: string): Promise<void>;
}

export function handleRunControl(ctx: AppContext, control: RunControl, deps: RunControlDeps): void {
  const report = (source: string) => (err: unknown) => {
    console.warn(`could not act on ${control.action} for run ${control.runId}:`, err);
    ctx.analytics?.captureException(err, null, null, { run_id: control.runId, source });
  };
  switch (control.action) {
    case "cancel":
      ctx.running.get(control.runId)?.abort();
      return;
    case "nudge": {
      const live = ctx.liveInputs.get(control.runId);
      if (!live?.pump) return;
      live.pump().catch(report("run_nudge"));
      return;
    }
    case "close":
      ctx.liveInputs.get(control.runId)?.close?.();
      return;
    case "tick": {
      const live = ctx.liveInputs.get(control.runId);
      if (!live?.waiting?.()) return;
      deps.tickHeldPlanner(control.runId).catch(report("planner_tick"));
      return;
    }
    case "released":
      deps.adopt().catch(report("run_adopt"));
      return;
  }
}
