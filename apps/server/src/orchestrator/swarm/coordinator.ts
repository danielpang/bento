import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agentRuns,
  repositories,
  runArtifacts,
  runEvents,
  sandboxes,
  swarmLandings,
  swarmMessages,
  swarmTaskEvents,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import type { AppContext, LiveInput } from "../../context.js";
import { driverForSandbox } from "../sandbox-driver.js";
import type { BoardEvent } from "../../events.js";
import { captureJobErrors } from "../../analytics.js";
import { unbilledReason } from "../../unbilled-reasons.js";
import { enqueueRun, INTERACTIVE_POLL_SECONDS } from "../queue.js";
import { queueSwarmSandboxReap } from "../reap-sandbox.js";
import { swarmHasActiveRun } from "./reopen.js";
import { ACTIVE_RUN_STATUSES, projectHasRepositories, SWARM_FULL, startRunIfIdle, type NewRun, type OutOfCompute } from "../start-run.js";
import { plannerWakeMessage, quoteUntrusted, type PlannerWakeItem } from "./planner-prompt.js";
import { enqueueLanding, MAX_LANDING_ATTEMPTS } from "./landing.js";
import { enqueueSwarmPush } from "./remote-branches.js";
import { resumeStartOvers } from "./start-over.js";
import { retryLeaf } from "./task-actions.js";
import { ensureFinalCheck, isFinalCheck } from "./final-check.js";
import {
  assembleSwarmDocumentInSandbox,
  DOCUMENT_ASSEMBLY_FLAG,
  documentAssemblyPass,
  isDocumentAssembly,
  isDocumentSwarm,
} from "./deliverable.js";
import { SWARM_DESIGN_PATH } from "./design-document.js";
import {
  handLeafToPlanner,
  MAX_PLANNER_RETELLS,
  PLANNER_NOT_TOLD,
  PLANNER_RETELLS_EXHAUSTED,
  withoutAcceptance,
} from "./planner-news.js";
import { observedAverageRunCost, budgetIsLow, enforcedSpend, money, spendOf } from "./ledger.js";
import { ensureSwarmWatchdog, hasWatchedSwarms, stopSwarmWatchdog, WATCHED_SWARMS } from "./watchdog.js";
import { captureSwarmSpend, type SwarmSpendOutcome } from "./spend.js";
import { queueSwarmSlackNotify } from "../slack-notify.js";

/**
 * The swarm's reconciler: one function, run behind one queue, that
 * takes a swarm from whatever state it is in to the state its rows
 * imply.
 *
 * It is a reconciler rather than a sequence of callbacks on purpose.
 * Everything that happens in a swarm (a worker finishing, a person
 * answering a question, a budget running out, a server restarting
 * mid landing) ends the same way: enqueue a tick and let it read the
 * rows. Nothing has to remember to also update the parent's status, or
 * to start the next worker, because no caller is responsible for that
 * at all.
 *
 * Five steps, in this order, inside one transaction:
 *
 * 1. Roll status and cost up the tree, leaves to root.
 * 2. Fold everything the planner has not heard yet into one wake
 *    message, and start the planner with it.
 * 3. Spawn workers on ready leaves, up to the swarm's ceiling.
 * 4. Advance the landing queue.
 * 5. Recompute the swarm's own status.
 *
 * The order is the content. Rolling up first means every later step
 * reads a tree that already agrees with itself; waking the planner
 * before spawning means a plan change lands before workers are
 * committed to the old plan; the swarm's status is recomputed last
 * because the four steps above are what change it.
 *
 * Idempotent by construction: every step is a function of the rows, not
 * of what happened since the last tick, so a tick applied twice writes
 * nothing the second time. That is what makes it safe to enqueue a tick
 * from anywhere, including from a retry of a job that already ran.
 */

/** The queue. One worker covers it; see the poll interval at its registration. */
export const SWARM_TICK_QUEUE = "swarm.tick";

/**
 * The statuses that are worth polling for.
 *
 * A draft has not started, a paused swarm cancelled its runs when it
 * paused, and a done, failed or cancelled one is over: none of them has
 * anything in flight for a tick to reconcile, so none of them is a
 * reason to keep a worker awake. Resuming a paused swarm goes through
 * enqueueSwarmTick like every other door, which starts the worker
 * again.
 */
const ACTIVE_SWARM_STATUSES = ["planning", "running", "blocked"] as const;

/**
 * And the states a swarm is not working in, which end its machine.
 *
 * The two ceilings belong here with the three plain endings. A swarm
 * stopped because it spent too much holding on to a sprite that costs
 * money by the hour is the one machine nobody would choose to leave
 * running, and reopening one with a raised ceiling provisions again
 * the way its first spawn did.
 */
function swarmIsOver(status: (typeof swarms.$inferSelect)["status"]): boolean {
  return (
    status === "done" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "budget_exhausted" ||
    status === "timed_out"
  );
}

/**
 * Whether a swarm that ended this way is finished with its machine.
 *
 * Only "done" and "cancelled". Every other ending is one a person
 * picks up again from the same branch: a failed swarm by retrying a
 * leaf or a landing, and a swarm that ran out of budget or time by
 * raising the ceiling, which spawnsFrom resumes. The swarm's machine
 * holds that branch, and whatever GitHub has no copy of is lost with
 * it: reaping on failure turned a landing retry into "the swarm's
 * sandbox is gone" and lost the landed work. Archiving or deleting the
 * swarm still reaps it, the sweep takes one nobody has touched past
 * FAILED_SWARM_MACHINE_GRACE_MS, and a Modal machine hibernates on its
 * own meanwhile.
 */
export function swarmReleasesMachine(status: (typeof swarms.$inferSelect)["status"]): boolean {
  return swarmIsOver(status) && (status === "done" || status === "cancelled");
}

/** Whether any swarm on this deployment has work a tick would act on. */
export async function hasActiveSwarms(ctx: Pick<AppContext, "db">): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: swarms.id })
    .from(swarms)
    .where(inArray(swarms.status, [...ACTIVE_SWARM_STATUSES]))
    .limit(1);
  return Boolean(row);
}

/**
 * Which pg-boss instances already have a tick worker.
 *
 * Keyed by the boss rather than held as a module flag, because the
 * tests run many contexts in one process and each has its own.
 */
const tickWorkers = new WeakSet<object>();

/**
 * One thing at a time, per boss, for the worker's own lifecycle.
 *
 * Starting a worker and stopping one are two steps each: mark the
 * boss, then talk to pg-boss. Interleaved, they lose ticks. A caller
 * that read the mark while a stop sat between its delete and its
 * offWork sent a tick into a queue whose worker was already going
 * away, and one that read it just after registered a worker the stop
 * then removed. Everything that touches the mark goes through here, so
 * a send happens in the same turn as the registration it relies on.
 *
 * Lazy registration is untouched: this serializes the starts and
 * stops, it does not start anything, so a deployment that has never
 * run a swarm still polls for nothing.
 */
const workerLifecycle = new WeakMap<object, Promise<unknown>>();

function inTurn<T>(boss: object, step: () => Promise<T>): Promise<T> {
  const previous = workerLifecycle.get(boss) ?? Promise.resolve();
  // Whatever the previous turn did, including throwing, the next one
  // runs: a failed registration must not wedge the queue for good.
  const next = previous.then(step, step);
  workerLifecycle.set(
    boss,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/** The transaction handle drizzle hands the callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type Task = typeof swarmTasks.$inferSelect;
type TaskStatus = Task["status"];

/**
 * What the tick needs from the rest of the server, as functions.
 *
 * Injected rather than imported so the steps can be driven directly in
 * a test: the interesting part of this file is the arithmetic and the
 * ordering, and neither is worth a sandbox to exercise.
 */
export interface SwarmTickDeps {
  /**
   * Starts a run. Always the one door (startRunIfIdle), which is what
   * holds the per role concurrency rules; the coordinator never
   * inserts a run itself.
   */
  startRun(
    tx: Tx,
    values: NewRun,
  ): Promise<typeof agentRuns.$inferSelect | "busy" | "gone" | typeof SWARM_FULL | OutOfCompute>;
  /**
   * Hands a landing that just reached the front of the queue to
   * whatever performs it.
   *
   * Absent means nothing performs landings in this deployment yet, and
   * the step then only reconciles the queue (dropping landings whose
   * task went away) rather than promoting a row into a state no worker
   * would ever move out of.
   */
  startLanding?(tx: Tx, landingId: string): Promise<void>;
  now?(): Date;
  /**
   * The live sessions this process holds, by run id. A planner held
   * open between turns is on it, and the wake is written into that
   * process rather than starting a run. Absent, or a planner held by
   * another process, means the wake waits for the run to end the way
   * it always did.
   */
  liveInputs?: Map<string, LiveInput>;
}

/** What one tick did, for the log and for the tests. */
export interface SwarmTickResult {
  /** Tasks whose status this tick changed. */
  changedTasks: number;
  /** The planner run this tick started, if it started one. */
  plannerRunId: string | null;
  /**
   * The planner run a wake was written into live, held open since its
   * last turn. Separate from plannerRunId, which names a run this tick
   * started and the caller then enqueues: a held planner is already
   * executing, and enqueueing it again would start a second agent.
   */
  plannerToldLiveId: string | null;
  /** Worker runs started. */
  workerRunIds: string[];
  /** Resolver runs started on conflicted landings. */
  resolverRunIds: string[];
  /** Why the spawn loop stopped early, when a plan limit stopped it. */
  spawnRefusal: string | null;
  /** The landing at the front of the queue, if any is in flight. */
  landingId: string | null;
  /** Whether this tick is what promoted it, rather than finding it already running. */
  landingPromoted: boolean;
  /** A server-owned document assembly step ready to run after commit. */
  documentAssemblyTaskId: string | null;
  /** The swarm's status after the tick. */
  status: (typeof swarms.$inferSelect)["status"];
  /**
   * Whether this tick is what finished the swarm, rather than finding
   * it already finished.
   *
   * The publish that follows is keyed on the transition rather than on
   * the status, for the reason the landing promotion is: a tick runs
   * again for all sorts of reasons, and a job per tick on a swarm that
   * has been done for a week is a push per tick.
   */
  becameDone: boolean;
  /**
   * The ending this tick gave the swarm, if it gave it one.
   *
   * Separate from becameDone because a swarm ends five ways and only
   * one of them publishes, while all five are worth recording: what a
   * swarm that ran out of money spent is exactly as interesting as
   * what a finished one did, and more so.
   */
  becameFinal: SwarmSpendOutcome | null;
}

/** The states a swarm does not leave, and what each is called in the ledger. */
const FINAL_SWARM_STATUSES = ["done", "failed", "cancelled", "budget_exhausted", "timed_out"] as const;

/**
 * How many times an agent is started again on the same node after its
 * machine could not be made, before the planner is told.
 *
 * A run that failed before its agent started is the sandbox's failure
 * and not the work's: a sprite Fly could not hand over, a Modal
 * machine that was never made, an exec socket that dropped under the
 * clone. Nothing about the leaf changed, and the planner can do
 * nothing about it but say "try again", which is a turn of a strong
 * model spent on a sentence. So the coordinator says it instead, a
 * bounded number of times. The bound is what keeps a provider that is
 * down for the afternoon from starting a machine a minute forever:
 * past it the planner is told, with the error and the count, and
 * decides as it would about any other stopped worker.
 *
 * The same bound covers the planner's own run. A wake that died
 * before its agent started was never heard, and the latch that folds
 * each leaf's news into one wake has already been set for it, so
 * without this the swarm sat with reported leaves nobody would ever
 * decide on until a person pressed retry.
 */
export const MAX_SANDBOX_RESTARTS = 3;

/** Where a leaf counts its restarts, read by the drawer as any other flag. */
const SANDBOX_RESTARTS_FLAG = "sandboxRestarts";

function sandboxRestarts(flags: unknown): number {
  const value = typeof flags === "object" && flags !== null ? (flags as Record<string, unknown>)[SANDBOX_RESTARTS_FLAG] : 0;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * A run that failed before its agent started.
 *
 * The unbilled-reason rules are the one list of those failures: they
 * exist so a person is not charged for a machine that never ran their
 * agent, and that is the same question as whether the work was ever
 * attempted. Read here rather than copied, so a provider failure that
 * joins that list is restarted without this file learning its words.
 */
function failedBeforeAgentStarted(run: { status: string; error: string | null }): boolean {
  if (run.status !== "failed") return false;
  const reason = unbilledReason(run.error);
  // A lost branch is unbilled (no agent ran) but not a sandbox blip:
  // another start finds the same nothing, so it goes to the planner and
  // the person rather than round the restart loop.
  return reason !== null && reason.id !== "swarm-branch-lost";
}

/**
 * Reconciles one swarm.
 *
 * The board events are emitted after the transaction commits, never
 * inside it: a viewer that refetches on an event has to find the state
 * the event describes, and a client that refetched inside the
 * transaction would read the rows as they were before it.
 *
 * The runs this tick started are queued after the commit for the same
 * reason, and because a run that is not queued is a run that never
 * happens: startRunIfIdle writes a row in the queued status, and only
 * enqueueRun turns that row into a `run.execute` job. Without it the
 * row sits queued forever, the next tick reads it as this swarm being
 * busy, and the swarm stops for good with nothing saying why.
 */
export async function tickSwarm(
  ctx: AppContext,
  swarmId: string,
  deps: SwarmTickDeps = {
    startRun: (tx, values) => startRunIfIdle(tx as unknown as Db, values, ctx.entitlements, ctx.analytics),
    /**
     * Present, and empty. Its presence is what tells step four this
     * deployment performs landings at all, and it does nothing here
     * because the job must not be sent from inside the transaction:
     * a worker that picked it up before the commit would read the row
     * as still queued and drop it. The send happens below, on the id
     * the tick returns.
     */
    startLanding: async () => {},
    liveInputs: ctx.liveInputs,
  },
): Promise<SwarmTickResult | null> {
  const events: BoardEvent[] = [];
  const result = await ctx.db.transaction(async (tx) => runTick(tx, swarmId, deps, events));
  for (const event of events) ctx.bus.emitBoardEvent(event);
  if (result) {
    for (const runId of [
      ...(result.plannerRunId ? [result.plannerRunId] : []),
      ...result.workerRunIds,
      ...result.resolverRunIds,
    ]) {
      await enqueueRun(ctx, runId);
    }
    /**
     * The landing this tick promoted, once the promotion is committed.
     *
     * Only when this tick moved the row: the id is also returned for a
     * landing that was already in flight, and enqueuing that one on
     * every tick would be a job per tick for as long as it ran.
     */
    if (result.landingId && result.landingPromoted) {
      try {
        await enqueueLanding(ctx, result.landingId);
      } catch (err) {
        /**
         * The claim goes back if the job could not be sent.
         *
         * The promotion is committed by now, so a send that throws
         * leaves a row that says "landing" with nothing anywhere that
         * will ever perform it: this tick is retried and deliberately
         * does not re-enqueue a row already in flight, nothing sweeps a
         * claimed row with no job, and resumeClaimedLandings only runs
         * at boot. The partial unique index then refuses every other
         * landing in that swarm, so one failed send ends the whole
         * queue until a restart. Releasing it puts the row back at the
         * front of the queue for the retried tick to promote again.
         */
        await ctx.db
          .update(swarmLandings)
          .set({
            status: "queued",
            startedAt: null,
            // The attempt never happened, so it is not counted: the
            // count is what fails a branch git keeps refusing, and a
            // queue that could not be reached is not that.
            attempt: sql`greatest(${swarmLandings.attempt} - 1, 0)`,
            updatedAt: new Date(),
          })
          .where(and(eq(swarmLandings.id, result.landingId), eq(swarmLandings.status, "landing")))
          .catch(() => {});
        throw err;
      }
    }
    // Every task waiting to start over has its job; one a restart lost is asked for again.
    await resumeStartOvers(ctx, swarmId);
    /*
     * Assembly touches git and may talk to a remote sandbox, so it is
     * outside the transaction. Its assigned task is the durable claim:
     * a crash leaves it ready (or working) for the retried tick, and a
     * success is reconciled immediately so the final check sees the
     * document it is judging.
    */
    if (result.documentAssemblyTaskId) {
      const executed = await executeDocumentAssembly(ctx, result.documentAssemblyTaskId);
      return executed ? tickSwarm(ctx, swarmId, deps) : result;
    }
    /**
     * A swarm that just finished has its branch pushed once more, on
     * the push queue rather than inline, because it clones, pushes and
     * talks to GitHub, and the tick worker runs one job at a time for
     * every swarm on the deployment. The pull requests are a person's
     * choice now (POST /api/swarms/:id/publish), so nothing opens one.
     */
    /*
     * Pushed, not published: the branch goes to GitHub (it has been
     * going after every landing; this catches anything since), and the
     * pull requests wait for a person to choose one for the swarm or
     * one per task.
     */
    if (result.becameDone) {
      await enqueueSwarmPush(ctx, { kind: "swarm", swarmId });
      await queueSwarmSlackNotify(ctx, { type: "swarm_completed", swarmId });
    }
    /*
     * And what it cost, once, on whichever ending it reached. On the
     * transition rather than the status, for the reason the publish is:
     * a tick runs again for all sorts of reasons, and an event per tick
     * on a swarm that finished last week would be a spend report per
     * tick.
     */
    if (result.becameFinal) await captureSwarmSpend(ctx, swarmId, result.becameFinal);
    /*
     * A swarm that is over holds a machine nobody is working in, and a
     * sprite costs money for as long as it exists rather than for as
     * long as it is used. Queued rather than destroyed here, for the
     * reason the card's reap is queued: the provider is a network call
     * away and a finished swarm must not fail to finish because Fly
     * was slow. Safe to queue twice, because the reap reads the rows
     * and a machine already gone is no rows.
     *
     * The publish above is asked for on the transition and this on the
     * status, which is deliberate: publishing twice would open a second
     * pull request, and reaping twice is no rows.
     *
     * Never for a failed swarm (swarmReleasesMachine says why), and
     * not while a run is still in flight. A tree that ends can wake its
     * planner in this same tick, and that run works in this machine.
     * Every later tick would ask for the machine again, the job would
     * refuse, and each refusal would be recorded as an error for as
     * long as the agent kept working. The run's settlement is another
     * tick, and that one queues the reap once nothing is left in
     * flight. A job that loses the race and finds a run anyway asks
     * again later rather than failing.
     */
    if (swarmReleasesMachine(result.status) && !(await swarmHasActiveRun(ctx.db, swarmId))) {
      await queueSwarmSandboxReap(ctx, swarmId);
    }
  }
  return result;
}

async function runTick(
  tx: Tx,
  swarmId: string,
  deps: SwarmTickDeps,
  events: BoardEvent[],
): Promise<SwarmTickResult | null> {
  const now = deps.now?.() ?? new Date();
  /**
   * The swarm row is locked first, so two ticks for the same swarm
   * serialize rather than both counting workers against a ceiling and
   * both deciding there is room. pg-boss coalesces ticks by singleton
   * key, which makes a second tick rare; rare is not never.
   */
  const [swarm] = await tx.select().from(swarms).where(eq(swarms.id, swarmId)).for("update");
  if (!swarm) return null;

  const tasks = await tx
    .select()
    .from(swarmTasks)
    .where(eq(swarmTasks.swarmId, swarmId))
    .orderBy(asc(swarmTasks.position), asc(swarmTasks.createdAt));

  await settleWorkedLeaves(tx, swarm, tasks, events, now);
  /*
   * First make every plan node agree with its children, then decide
   * whether the whole ordinary tree is ready for its last check.
   *
   * The order matters for nested trees. A leaf can become done while
   * its parent still says working in the rows this tick read. Asking
   * for the final check before rolling that parent up misses the check,
   * then the same tick marks the swarm done and publishes it. The new
   * check is still put on the in-memory tree before spawning and the
   * final status calculation, so it gates completion immediately.
   */
  const changed = await rollUp(tx, swarm, tasks, events);
  const assembly = await ensureDocumentAssembly(tx, swarm, changed.tasks, events, now);
  if (assembly.created) changed.tasks.push(assembly.created);

  const check = await ensureFinalCheck(tx, swarm, changed.tasks, now);
  if (check.created) {
    changed.tasks.push(check.created);
    events.push({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: check.created.id,
      status: check.created.status,
    });
  }

  await warnLowBudget(tx, swarm, now);
  /**
   * A run cancelled because the project has no checkout settles into
   * this tick. The leaf above is recorded as stopped. Starting a
   * planner, a worker, or a resolver here would queue another run for
   * the same reason, and that run would cancel into another tick.
   */
  const canStartAgents = await projectHasRepositories(tx as unknown as Db, swarm.projectId);
  /*
   * A planner whose machine could not be made is started again before
   * any new wake is considered: the wake it was carrying is on its row,
   * and a run queued here is the active planner that holds every later
   * wake until it has been heard.
   */
  await flagUndecidedLeaves(tx, swarm, changed.tasks, events, now);
  /*
   * A ceiling that refused the planner or a resolver is collected here,
   * so the swarm pauses (or ends on its budget) the way it does when a
   * worker is refused. Before, only a worker's refusal said anything:
   * a swarm whose one remaining step was a planner turn sat "running"
   * with nothing starting and nothing saying why.
   */
  const refusals: ComputeRefusal[] = [];
  let plannerRunId: string | null = null;
  let plannerToldLiveId: string | null = null;
  if (canStartAgents) {
    plannerRunId = await restartPlannerAfterSandboxFailure(tx, swarm, deps, refusals, events, now);
    if (!plannerRunId) {
      await noticeIdleOpenLeaves(tx, swarm, changed.tasks, now);
      const woken = await deliverPlannerWake(tx, swarm, deps, now, refusals, events);
      if (woken?.live) plannerToldLiveId = woken.runId;
      else if (woken) plannerRunId = woken.runId;
    }
  }
  const spawned = canStartAgents
    ? await spawnWorkers(tx, swarm, changed.tasks, deps, events, now)
    : { runIds: [], refusal: null, cap: null };
  const landing = await advanceLandingQueue(tx, swarm, changed.tasks, deps, events, now, canStartAgents, refusals);
  const status = await recomputeSwarmStatus(tx, swarm, changed.tasks, events, withRefusals(swarm, spawned, refusals));

  return {
    changedTasks: changed.changedCount,
    plannerRunId,
    plannerToldLiveId,
    workerRunIds: spawned.runIds,
    resolverRunIds: landing.resolverRunIds,
    spawnRefusal: spawned.refusal,
    landingId: landing.landing?.id ?? null,
    landingPromoted: landing.landing?.promoted ?? false,
    documentAssemblyTaskId: assembly.ready?.id ?? null,
    status,
    becameDone: status === "done" && swarm.status !== "done",
    /**
     * What it spent, reported on the first ending it reaches and not
     * on any ending after that.
     *
     * A swarm ends more than once on the ordinary path: nothing is
     * killed for a ceiling, so one that stopped on its budget or its
     * clock goes on to finish the tree its last workers were landing,
     * and that second transition is a second final status. The event's
     * own contract is one per finished unit of work, because the
     * dashboard sums cost_usd rather than counting events, so a second
     * report would double every figure on it. The ending that is
     * reported is the one that actually stopped the swarm spawning,
     * which is also the more informative of the two.
     */
    becameFinal:
      status !== swarm.status &&
      (FINAL_SWARM_STATUSES as readonly string[]).includes(status) &&
      !(FINAL_SWARM_STATUSES as readonly string[]).includes(swarm.status)
        ? (status as SwarmSpendOutcome)
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * Step 1a: assemble a document before anything judges or publishes it.
 * ------------------------------------------------------------------ */

interface DocumentAssemblyStep {
  created: Task | null;
  ready: Task | null;
}

const DOCUMENT_ASSEMBLY_LEASE_MS = 5 * 60 * 1000;

/**
 * Adds one server-owned assembly node per pass through the swarm.
 *
 * The node is the persisted gate. It is excluded from agent spawning,
 * but otherwise behaves like a leaf: assigned means the server should
 * run it, blocked carries a visible failure, Retry puts it back in the
 * queue, and done lets the final check start. A follow up gets another
 * node because reopenCount is part of the flag.
 */
async function ensureDocumentAssembly(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  events: BoardEvent[],
  now: Date,
): Promise<DocumentAssemblyStep> {
  if (!isDocumentSwarm(swarm)) return { created: null, ready: null };
  const ordinary = tasks.filter(
    (task) => task.status !== "cancelled" && !isFinalCheck(task) && !isDocumentAssembly(task),
  );
  if (ordinary.length === 0 || !ordinary.every((task) => task.status === "done")) {
    return { created: null, ready: null };
  }

  const matching = tasks.filter((task) => documentAssemblyPass(task) === swarm.reopenCount);
  const complete = matching.find(
    (task) => task.status === "done" && task.flags.documentAssemblyComplete === true,
  );
  if (complete) return { created: null, ready: null };
  const assigned = matching.find((task) => task.status === "assigned");
  if (assigned) return { created: null, ready: assigned };
  const staleWorking = matching.find(
    (task) =>
      task.status === "working"
      && task.updatedAt.getTime() <= now.getTime() - DOCUMENT_ASSEMBLY_LEASE_MS,
  );
  if (staleWorking) return { created: null, ready: staleWorking };
  // The external git work happens after the transaction commits. A
  // fresh working row is its lease, so a second tick cannot run the
  // same assembly against the checkout at the same time. A crashed
  // process is recovered after the short lease above expires.
  if (matching.some((task) => task.status === "working")) return { created: null, ready: null };
  // A visible failure waits for an explicit Retry. It must not turn a
  // transient provider failure into an unbounded loop of git attempts.
  if (matching.some((task) => task.status === "blocked")) return { created: null, ready: null };

  const [{ next } = { next: 0 }] = await tx
    .select({ next: sql<number>`coalesce(max(${swarmTasks.position}), -1) + 1` })
    .from(swarmTasks)
    .where(and(eq(swarmTasks.swarmId, swarm.id), sql`${swarmTasks.parentId} is null`));
  const [created] = await tx
    .insert(swarmTasks)
    .values({
      swarmId: swarm.id,
      parentId: null,
      position: next,
      nodeType: "leaf",
      status: "assigned",
      title: "Assemble document",
      description: "Assemble the finished sections into the document this swarm delivers.",
      flags: { [DOCUMENT_ASSEMBLY_FLAG]: true, reopenCount: swarm.reopenCount },
      updatedAt: now,
    })
    .returning();
  if (!created) throw new Error("the document assembly step inserted no row");
  await tx.insert(swarmTaskEvents).values({
    taskId: created.id,
    kind: "created",
    toStatus: "assigned",
    detail: { documentAssembly: true, reopenCount: swarm.reopenCount },
  });
  events.push({
    type: "swarm_task_updated",
    projectId: swarm.projectId,
    swarmId: swarm.id,
    taskId: created.id,
    status: "assigned",
  });
  return { created, ready: created };
}

/** Runs the durable assembly step against the swarm's actual sandbox. */
async function executeDocumentAssembly(ctx: AppContext, taskId: string): Promise<boolean> {
  const [task] = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)).limit(1);
  if (!task || !isDocumentAssembly(task) || (task.status !== "assigned" && task.status !== "working")) return false;
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, task.swarmId)).limit(1);
  if (!swarm || documentAssemblyPass(task) !== swarm.reopenCount) return false;

  const claimedAt = new Date();
  const [claimed] = await ctx.db
    .update(swarmTasks)
    .set({ status: "working", startedAt: task.startedAt ?? claimedAt, updatedAt: claimedAt })
    .where(
      and(
        eq(swarmTasks.id, task.id),
        or(
          eq(swarmTasks.status, "assigned"),
          and(
            eq(swarmTasks.status, "working"),
            lt(swarmTasks.updatedAt, new Date(claimedAt.getTime() - DOCUMENT_ASSEMBLY_LEASE_MS)),
          ),
        ),
      ),
    )
    .returning({ id: swarmTasks.id });
  if (!claimed) return false;

  try {
    if (!swarm.branchName) throw new Error("the swarm has no branch to assemble the document on");
    if (!swarm.sandboxId) throw new Error("the swarm workspace is not available");
    const [[sandbox], [repository], [design]] = await Promise.all([
      ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId)).limit(1),
      ctx.db
        .select({ name: repositories.name })
        .from(repositories)
        .where(eq(repositories.projectId, swarm.projectId))
        .orderBy(asc(repositories.position))
        .limit(1),
      ctx.db
        .select({ content: runArtifacts.content })
        .from(runArtifacts)
        .where(and(eq(runArtifacts.swarmId, swarm.id), eq(runArtifacts.path, SWARM_DESIGN_PATH)))
        .orderBy(desc(runArtifacts.createdAt))
        .limit(1),
    ]);
    if (!sandbox || sandbox.status === "destroyed") throw new Error("the swarm workspace is not available");
    if (!repository) throw new Error("the project has no repository for the document");
    const assembled = await assembleSwarmDocumentInSandbox(ctx.db, {
      swarm,
      driver: driverForSandbox(ctx.drivers, sandbox),
      handle: { externalId: sandbox.externalId, provider: sandbox.provider, workdir: sandbox.workdir },
      repositoryName: repository.name,
      branch: swarm.branchName,
      preamble: design?.content ?? null,
    });
    if (!assembled) throw new Error("the finished plan had no sections to assemble");
    const recorded = await ctx.db.transaction(async (tx) => {
      const [finished] = await tx
        .update(swarmTasks)
        .set({
          status: "done",
          attention: null,
          report: `Assembled ${assembled.sections} sections at ${assembled.path}.`,
          endedAt: new Date(),
          flags: { ...task.flags, documentAssemblyComplete: true, assemblyError: undefined },
          updatedAt: new Date(),
        })
        .where(and(eq(swarmTasks.id, task.id), eq(swarmTasks.status, "working")))
        .returning({ id: swarmTasks.id });
      if (!finished) return false;
      await tx.insert(swarmTaskEvents).values({
        taskId: task.id,
        kind: "status_changed",
        fromStatus: "working",
        toStatus: "done",
        detail: { path: assembled.path, sections: assembled.sections, written: assembled.written },
      });
      return true;
    });
    if (!recorded) return true;
    ctx.bus.emitBoardEvent({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "done",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const recorded = await ctx.db.transaction(async (tx) => {
      const [blocked] = await tx
        .update(swarmTasks)
        .set({
          status: "blocked",
          attention: "failed",
          report: `Document assembly failed: ${reason}`,
          flags: { ...task.flags, assemblyError: reason, plannerToldAt: undefined, plannerToldBy: undefined, plannerRetells: undefined },
          updatedAt: new Date(),
        })
        .where(and(eq(swarmTasks.id, task.id), eq(swarmTasks.status, "working")))
        .returning({ id: swarmTasks.id });
      if (!blocked) return false;
      await tx.insert(swarmTaskEvents).values({
        taskId: task.id,
        kind: "status_changed",
        fromStatus: "working",
        toStatus: "blocked",
        detail: { documentAssembly: true, reason },
      });
      await tx.insert(swarmMessages).values({
        swarmId: swarm.id,
        source: "system",
        status: "queued",
        text: `Document assembly for task ${task.id} failed: ${reason}. Inspect the workspace, then retry that task.`,
      });
      return true;
    });
    if (!recorded) return true;
    ctx.bus.emitBoardEvent({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "blocked",
    });
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Step 0: close leaves whose worker has stopped.
 * ------------------------------------------------------------------ */

/**
 * What a leaf is once the agent on it is no longer running.
 *
 * A worker ends its task by calling report, which writes the summary
 * onto the leaf and leaves the status alone: a reported leaf is still
 * in flight, because the planner has not yet said whether it is done or
 * is going back. That is the case this step does nothing about, and it
 * is the common one.
 *
 * The case it exists for is the other one: a run that stopped without
 * reporting. The agent crashed, ran out of context, hit its budget, or
 * simply ended its turn without calling the tool. Nothing else in the
 * swarm notices. The leaf stays "working" with no agent on it, the
 * spawn step passes over it because it is not "assigned", the planner
 * is never woken because the wake only carries leaves it has not heard
 * about, and the swarm sits at "running" forever with nothing moving.
 * Every swarm with one flaky worker ended that way.
 *
 * A successful run may end with a final message but miss the report
 * tool. That message is still useful to the planner, so recover it as
 * a report. A run without either is failed, with the reason on the row.
 *
 * Runs first: a leaf with no run at all has not started yet, and is
 * left to the spawn step rather than failed for never having begun.
 */
async function settleWorkedLeaves(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  events: BoardEvent[],
  now: Date,
): Promise<void> {
  /*
   * A plan node handed to a planner of its own is here too, and for
   * the same reason.
   *
   * A sub planner finishes by having written children: the rollup then
   * owns the node's status and nothing below is stuck. A sub planner
   * that stopped without writing any leaves that node "working" with
   * no agent on it and no children to roll up, which nothing else in
   * the swarm notices, and the subtree never happens. Only a childless
   * one, because a node with children is the rollup's and not this
   * step's.
   */
  const childless = new Set(tasks.map((task) => task.parentId).filter((id): id is string => id !== null));
  const working = tasks.filter(
    (task) =>
      task.status === "working" &&
      task.assignedRunId &&
      (task.nodeType === "leaf" ? !task.report : !childless.has(task.id)),
  );
  if (working.length === 0) return;

  const runs = await tx
    .select({ id: agentRuns.id, status: agentRuns.status, error: agentRuns.error })
    .from(agentRuns)
    .where(inArray(agentRuns.id, working.map((task) => task.assignedRunId!)));
  const byRun = new Map(runs.map((run) => [run.id, run]));

  for (const task of working) {
    const run = byRun.get(task.assignedRunId!);
    // A run row that is gone takes its leaf with it: there is nothing
    // left that could still report, so this is the same case.
    if (run && (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) continue;
    /*
     * A machine that could not be made is not a worker that stopped.
     * The node goes back to the queue and the spawn step below puts
     * another agent on it this same tick, on the same branch and, on
     * a driver that names machines, the same machine. Only so many
     * times: see MAX_SANDBOX_RESTARTS.
     */
    const restarts = run && failedBeforeAgentStarted(run) ? sandboxRestarts(task.flags) : null;
    if (run && restarts !== null && restarts < MAX_SANDBOX_RESTARTS) {
      await restartAfterSandboxFailure(tx, swarm, task, run, restarts + 1, events, now);
      continue;
    }
    /*
     * Its machine failed past its restarts. Once per task, before the
     * planner or a person is asked, the task starts over in a new
     * machine: the failure is the sandbox's, never the work's, and the
     * work is already on GitHub. A job takes the old machine down
     * (resumeStartOvers asks for it after this tick commits).
     */
    if (
      run &&
      restarts !== null &&
      task.nodeType === "leaf" &&
      !(task.flags as { autoStartedOver?: boolean }).autoStartedOver
    ) {
      // The verdict goes with the attempt: a task started over is work
      // nobody has accepted yet.
      const restarted = await retryLeaf(tx as unknown as Parameters<typeof retryLeaf>[0], {
        task: withoutAcceptance(task),
        fresh: true,
        auto: true,
        now,
      });
      if (!("refused" in restarted)) {
        Object.assign(task, restarted);
        events.push({ type: "swarm_task_updated", projectId: swarm.projectId, swarmId: swarm.id, taskId: task.id, status: task.status });
        continue;
      }
    }
    if (task.nodeType === "leaf" && run?.status === "succeeded") {
      const [lastMessage] = await tx
        .select({ payload: runEvents.payload })
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "message"), sql`${runEvents.payload} ->> 'role' = 'assistant'`))
        .orderBy(desc(runEvents.seq))
        .limit(1);
      const text = (lastMessage?.payload as { text?: unknown } | undefined)?.text;
      const report = typeof text === "string" ? text.trim() : "";
      if (report) {
        await tx.update(swarmTasks).set({ report, attention: null, endedAt: task.endedAt ?? now, updatedAt: now })
          .where(eq(swarmTasks.id, task.id));
        await tx.insert(swarmTaskEvents).values({
          taskId: task.id,
          kind: "reported",
          runId: run.id,
          detail: { source: "final_message", reportToolMissing: true },
        });
        task.report = report;
        task.attention = null;
        events.push({ type: "swarm_task_updated", projectId: swarm.projectId, swarmId: swarm.id, taskId: task.id, status: task.status });
        continue;
      }
    }
    const reason =
      restarts !== null
        ? `its sandbox could not be made, ${restarts + 1} times in a row: ${run?.error?.trim() ?? "unknown error"}`
        : run?.error?.trim()
          ? `the agent working it stopped: ${run.error.trim()}`
          : task.nodeType === "plan"
            ? "the planner given this part of the plan stopped without writing any tasks under it."
            : "the agent working it stopped without reporting.";
    // Through the one door, so the latch that decides whether the
    // planner ever hears about this leaf is cleared by construction.
    await handLeafToPlanner(tx, {
      task,
      status: "failed",
      attention: "failed",
      // The restart count ends with the series it counted. A planner
      // that queues this leaf again starts a new one, with the policy
      // whole; left in place, every later machine that could not be
      // made would skip straight here, saying "four in a row" of one.
      flags: { workerStopped: reason, [SANDBOX_RESTARTS_FLAG]: undefined },
      set: { endedAt: task.endedAt ?? now },
      runId: task.assignedRunId,
      detail: { reason },
      now,
    });
    // The in-memory row too, so the roll up below reads the tree this
    // step just changed rather than the tree as it was before it.
    task.status = "failed";
    task.attention = "failed";
    events.push({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "failed",
    });
  }
}

/**
 * Puts a node whose machine could not be made back in the queue.
 *
 * Back to "assigned", which is the state the spawn step starts from
 * for a leaf and for a plan node alike, with the dead run taken off
 * it so a stale assignedRunId cannot read as an agent still on it.
 * The count goes on the node's flags, where the drawer shows it, and
 * the event log says which run died and why, so a person reading the
 * node afterwards sees three machines that were never made rather
 * than three agents that stopped.
 *
 * Not through handLeafToPlanner: this is the one stop the planner is
 * deliberately not told about, so the latch is left as it was.
 */
async function restartAfterSandboxFailure(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  task: Task,
  run: { id: string; error: string | null },
  restart: number,
  events: BoardEvent[],
  now: Date,
): Promise<void> {
  const flags = { ...task.flags, [SANDBOX_RESTARTS_FLAG]: restart };
  await tx
    .update(swarmTasks)
    .set({ status: "assigned", assignedRunId: null, flags, updatedAt: now })
    .where(eq(swarmTasks.id, task.id));
  await tx.insert(swarmTaskEvents).values({
    taskId: task.id,
    kind: "status_changed",
    fromStatus: task.status,
    toStatus: "assigned",
    runId: run.id,
    detail: {
      reason: "sandbox",
      restart,
      of: MAX_SANDBOX_RESTARTS,
      error: run.error,
    },
  });
  // The in-memory row too, so the spawn step this tick sees a node
  // waiting for an agent rather than the row as it was read.
  task.status = "assigned";
  task.assignedRunId = null;
  task.flags = flags;
  events.push({
    type: "swarm_task_updated",
    projectId: swarm.projectId,
    swarmId: swarm.id,
    taskId: task.id,
    status: "assigned",
  });
}

/* ------------------------------------------------------------------ *
 * Step 1: roll status and cost up the tree.
 * ------------------------------------------------------------------ */

/** The three ways a swarm's spend is known, summed the same way. */
interface Cost {
  measured: number;
  estimated: number;
  assumed: number;
}

function addCost(a: Cost, b: Cost): Cost {
  return {
    measured: a.measured + b.measured,
    estimated: a.estimated + b.estimated,
    assumed: a.assumed + b.assumed,
  };
}

function leafCost(task: Task): Cost {
  return {
    measured: Number(task.costMeasuredUsd),
    estimated: Number(task.costEstimatedUsd),
    assumed: Number(task.costAssumedUsd),
  };
}

/**
 * What a plan node's status is, given its children.
 *
 * A plan node is never worked directly, so its status is a summary and
 * nothing else writes it. Cancelled children are left out of the
 * summary entirely: a cancelled sibling is work somebody withdrew, and
 * counting it would keep a node that is otherwise finished from ever
 * reading as done.
 */
export function rollUpStatus(current: TaskStatus, children: TaskStatus[]): TaskStatus {
  if (children.length === 0) return current;
  const live = children.filter((s) => s !== "cancelled");
  if (live.length === 0) return "cancelled";
  // Work in flight wins: a plan node with anything moving is working,
  // whatever else is waiting inside it. A landed child counts as in
  // flight because its branch is on the swarm's branch and the leaf is
  // not finished with until the planner says so.
  if (live.some((s) => s === "working" || s === "landed")) return "working";
  if (live.some((s) => s === "blocked")) return "blocked";
  if (live.every((s) => s === "done")) return "done";
  // Nothing is moving and nothing is blocked, so a failure below is
  // the node's own outcome rather than a stage it is passing through.
  if (live.some((s) => s === "failed")) return "failed";
  // Something has started, or something is waiting to. Both read as a
  // node underway; "open" is only true while nothing has begun.
  if (live.every((s) => s === "open")) return "open";
  return "working";
}

/**
 * What a node counts as in its parent's summary.
 *
 * Its own status, except for a leaf waiting to start over. That leaf is
 * "assigned" while a job takes its old machine down, and the spawn step
 * deliberately passes it over until the job is done, so in the summary
 * it read as waiting work beside, say, a failed sibling: the rollup
 * called the pair "failed", the swarm was written failed, and a failed
 * swarm spawns nothing, so the leaf a person had just restarted never
 * started. It is work in flight, and counts as such.
 */
function rollupStatusOf(task: Task, status: TaskStatus = task.status): TaskStatus {
  if (status === "assigned" && (task.flags as { startingOver?: boolean }).startingOver === true) return "working";
  return status;
}

function statusWithDependents(
  task: Task,
  children: Task[],
  subtreeStatus: ReadonlyMap<string, TaskStatus>,
): { own: TaskStatus; subtree: TaskStatus } {
  const contained = children
    .filter((child) => child.parentRelation === "contains")
    .map((child) => subtreeStatus.get(child.id)!);
  const dependent = children
    .filter((child) => child.parentRelation === "depends_on")
    .map((child) => subtreeStatus.get(child.id)!);
  // A prerequisite stays done so its dependent can start. The larger
  // tree still includes that dependent when deciding whether to finish.
  const own = task.nodeType === "plan" ? rollUpStatus(task.status, contained) : task.status;
  return {
    own,
    subtree: own === "done" && dependent.length > 0
      ? rollUpStatus(own, [own, ...dependent])
      : rollupStatusOf(task, own),
  };
}

/** Read current task statuses after spawning, including dependent work. */
function currentRootStatuses(tasks: Task[]): TaskStatus[] {
  const byParent = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }
  const subtreeStatus = new Map<string, TaskStatus>();
  const visit = (task: Task): TaskStatus => {
    const children = byParent.get(task.id) ?? [];
    for (const child of children) visit(child);
    const status = statusWithDependents(task, children, subtreeStatus).subtree;
    subtreeStatus.set(task.id, status);
    return status;
  };
  return (byParent.get(null) ?? []).map(visit);
}

interface RolledTasks {
  tasks: Task[];
  changedCount: number;
}

/**
 * Rewrites every group's status and every node's cost from its
 * children, deepest first, then the swarm's own spend from the top
 * level.
 *
 * Only rows that actually change are written, which is what makes a
 * second tick a no-op rather than a wave of updated_at churn and a
 * board event per node.
 */
async function rollUp(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  events: BoardEvent[],
): Promise<RolledTasks> {
  const byParent = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }

  const next = new Map<string, { status: TaskStatus; cost: Cost }>();
  const subtreeStatus = new Map<string, TaskStatus>();
  let changedCount = 0;

  /** Depth first, so a node is decided only after its children are. */
  const visit = (task: Task): Cost => {
    const children = byParent.get(task.id) ?? [];
    if (children.length === 0) {
      const cost = leafCost(task);
      next.set(task.id, { status: task.status, cost });
      subtreeStatus.set(task.id, rollupStatusOf(task));
      return cost;
    }
    /*
     * A node's own cost columns are left alone, and only its status is
     * rewritten.
     *
     * Who owns the cost rollup: the reader. A row's three figures are
     * the charges recorded against that one task, and the subtree sum
     * is derived from them wherever it is wanted (the console's
     * buildSwarmModel adds a node's own to its children's, and the
     * swarm's own spend below is the same sum taken here). Writing the
     * subtree total onto the group row instead made the two agree only
     * by accident: the console added the children in again on top of
     * it, and a charge that really belonged to the group (a sub
     * planner's turn) was overwritten by the next tick.
     */
    const own = leafCost(task);
    let cost = own;
    for (const child of children) cost = addCost(cost, visit(child));
    const status = statusWithDependents(task, children, subtreeStatus);
    subtreeStatus.set(task.id, status.subtree);
    next.set(task.id, {
      status: status.own,
      cost: own,
    });
    return cost;
  };

  /*
   * Walked for its writes rather than for a total: visit fills in what
   * every node's status and cost should be, and the swarm's own spend
   * is the ledger's (see below).
   */
  for (const root of byParent.get(null) ?? []) visit(root);

  const updated: Task[] = [];
  for (const task of tasks) {
    const computed = next.get(task.id);
    if (!computed) {
      updated.push(task);
      continue;
    }
    const statusChanged = computed.status !== task.status;
    const costChanged =
      computed.cost.measured !== Number(task.costMeasuredUsd)
      || computed.cost.estimated !== Number(task.costEstimatedUsd)
      || computed.cost.assumed !== Number(task.costAssumedUsd);
    if (!statusChanged && !costChanged) {
      updated.push(task);
      continue;
    }
    const [row] = await tx
      .update(swarmTasks)
      .set({
        status: computed.status,
        costMeasuredUsd: String(computed.cost.measured),
        costEstimatedUsd: String(computed.cost.estimated),
        costAssumedUsd: String(computed.cost.assumed),
        updatedAt: new Date(),
      })
      .where(eq(swarmTasks.id, task.id))
      .returning();
    updated.push(row ?? task);
    if (statusChanged) {
      changedCount += 1;
      await tx.insert(swarmTaskEvents).values({
        taskId: task.id,
        kind: "status_changed",
        fromStatus: task.status,
        toStatus: computed.status,
      });
      events.push({
        type: "swarm_task_updated",
        projectId: swarm.projectId,
        swarmId: swarm.id,
        taskId: task.id,
        status: computed.status,
      });
    }
  }

  /**
   * The swarm's own spend is not written here, and that is a change
   * worth stating.
   *
   * It used to be the sum of the tree, which is a smaller number than
   * the bill: a planner turn and a merge queue resolver belong to no
   * node, and those are two of the most expensive roles a swarm has.
   * A budget checked against a total that leaves the planner out is a
   * budget that lets a swarm spend past it without ever refusing
   * anything.
   *
   * So the ledger adds each run's charge to the swarm as the run ends,
   * and the swarm's four columns are the authority. The tree's figures
   * answer the other question, which is what each piece of work cost,
   * and this step keeps rolling those.
   */
  return { tasks: updated, changedCount };
}

/* ------------------------------------------------------------------ *
 * Step 1b: tell the planner when the money is nearly gone.
 * ------------------------------------------------------------------ */

/**
 * Queues one notice when what is left of the budget is less than one
 * more run.
 *
 * The planner is the only actor that can do anything useful with this.
 * It is the one deciding what happens next, and told in time it can
 * spend the remainder on the leaf that matters rather than on whatever
 * came next in tree order. Told nothing, it finds out by having a spawn
 * refused, which is the same information one run too late.
 *
 * Once per budget, which is what the latch on the swarm is for: this
 * runs on every tick, and a warning per tick would be a planner turn
 * per tick spent reading the same sentence. Raising the budget clears
 * the latch, because a raised budget is a different budget and running
 * low on it is news again.
 *
 * A message rather than a field the prompt reads, because the wake
 * message is how everything else reaches the planner, and folding it
 * in there means one turn answers the budget, the reports and the
 * people together.
 */
async function warnLowBudget(tx: Tx, swarm: typeof swarms.$inferSelect, now: Date): Promise<void> {
  if (swarm.budgetWarnedAt) return;
  if (swarm.status === "cancelled" || swarm.status === "done" || swarm.status === "draft") return;
  const perRun = await observedAverageRunCost(tx as unknown as Db, swarm);
  if (!budgetIsLow(swarm, perRun)) return;

  const cap = Number(swarm.budgetUsd);
  const spent = enforcedSpend(spendOf(swarm));
  await tx.insert(swarmMessages).values({
    swarmId: swarm.id,
    source: "system",
    text: [
      `This swarm has spent ${money(spent)} of its ${money(cap)} budget, which leaves less than one more run.`,
      "Decide what the rest is worth spending on: finish what is closest to done, cancel what no longer matters, and say what is left undone in your write-up.",
      "Nothing running is stopped. When the budget is gone the swarm stops starting new work, and a person can raise it.",
    ].join(" "),
  });
  await tx.update(swarms).set({ budgetWarnedAt: now, updatedAt: now }).where(eq(swarms.id, swarm.id));
  swarm.budgetWarnedAt = now;
}

/* ------------------------------------------------------------------ *
 * Step 2: fold what the planner has not heard into one wake message.
 * ------------------------------------------------------------------ */

/**
 * Starts the planner again when its last run died before its agent
 * started.
 *
 * The prompt is the failed run's own: the first plan's is empty and
 * the executor builds it, and a wake's is the message that folded the
 * leaves' news into it. Starting the same prompt again is what makes
 * the latch on those leaves still true, because the planner is now
 * going to hear exactly what the latch says it was told.
 *
 * Bounded by counting back from the latest run: each restart is a
 * planner run that failed the same way, so a trailing run of them
 * longer than MAX_SANDBOX_RESTARTS means the provider has been down
 * for every try and the swarm waits, as it did before this existed,
 * for a person or the next wake. Only while the swarm is being
 * worked: a wake may reach an ended swarm, a restart carries no news
 * and must not.
 */
async function restartPlannerAfterSandboxFailure(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  deps: SwarmTickDeps,
  refusals: ComputeRefusal[],
  events: BoardEvent[],
  now: Date,
): Promise<string | null> {
  /*
   * Only a swarm that is being worked. A wake may still reach an
   * ended swarm, because a leaf can report after its ceiling; a
   * restart carries no news and must not put a planner on a swarm
   * that is done, timed out or out of budget. A swarm paused on its
   * plan's hours is being worked: a refused restart is what paused it,
   * and asking again is how it leaves the pause.
   */
  if (
    swarm.status !== "planning" &&
    swarm.status !== "running" &&
    swarm.status !== "blocked" &&
    !pausedOnPlanLimit(swarm)
  ) {
    return null;
  }

  const recent = await tx
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      error: agentRuns.error,
      prompt: agentRuns.prompt,
      agentProfileId: agentRuns.agentProfileId,
      startedBy: agentRuns.startedBy,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner")))
    .orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id))
    .limit(MAX_SANDBOX_RESTARTS + 1);
  const latest = recent[0];
  if (!latest || !failedBeforeAgentStarted(latest)) return null;
  let trailing = 0;
  for (const run of recent) {
    if (!failedBeforeAgentStarted(run)) break;
    trailing += 1;
  }
  if (trailing > MAX_SANDBOX_RESTARTS) return null;

  const profileId = (await plannerProfileFor(tx, swarm)) ?? latest.agentProfileId;
  if (!profileId) return null;
  const started = await deps.startRun(tx, {
    type: "swarm",
    swarmId: swarm.id,
    role: "planner",
    agentProfileId: profileId,
    prompt: latest.prompt,
    executor: "server",
    startedBy: latest.startedBy,
  });
  if (started !== "busy" && started !== "gone" && started !== SWARM_FULL && "outOfCompute" in started) {
    refusals.push({ refusal: started.outOfCompute, cap: started.cap ?? "plan" });
    return null;
  }
  if (started === "busy" || started === "gone" || started === SWARM_FULL) return null;
  await resumeFromPlanLimit(tx, swarm, events, now);
  /*
   * And the messages it carried. The prompt is the same, so they are
   * this run's now, for the reason the leaves below are restamped:
   * left on the failed run, the wake would put them back in the queue
   * and hand them over a second time.
   */
  await tx
    .update(swarmMessages)
    .set({ runId: started.id })
    .where(and(eq(swarmMessages.runId, latest.id), eq(swarmMessages.status, "sent")));
  /*
   * The leaves the failed run was told about are now this run's news:
   * it carries the same prompt. Restamped, or PLANNER_NOT_TOLD would
   * read them as lost with the failed run and hand them to yet another
   * planner once this one had already decided. Not a re-tell, so the
   * count is left alone: this restart has its own bound above.
   */
  const moved = await tx
    .update(swarmTasks)
    .set({ flags: sql`${swarmTasks.flags} || jsonb_build_object('plannerToldBy', ${started.id}::text)` })
    .where(and(eq(swarmTasks.swarmId, swarm.id), sql`${swarmTasks.flags} ->> 'plannerToldBy' = ${latest.id}::text`))
    .returning({ id: swarmTasks.id });
  for (const task of moved) {
    await tx.insert(swarmTaskEvents).values([
      {
        taskId: task.id,
        kind: "review_interrupted",
        runId: latest.id,
        detail: { note: "The planner reviewing this could not start, so it is being started again." },
      },
      {
        taskId: task.id,
        kind: "review_requested",
        runId: started.id,
        detail: { note: "The planner was started again with this to decide." },
      },
    ]);
  }
  return started.id;
}

/** Whether a leaf's latch is set: its news went out in some wake. */
function isTold(flags: Record<string, unknown>): boolean {
  return typeof flags.plannerToldAt === "string" && flags.plannerToldAt !== "";
}

function retellCount(flags: Record<string, unknown>): number {
  const value = flags.plannerRetells;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The planner a wake went to: a run this tick started, or one held open that heard it live. */
interface PlannerWoken {
  runId: string;
  live: boolean;
}

/**
 * Everything waiting for the planner becomes one message and one turn.
 *
 * Held while a planner run is mid turn, for two reasons. A CLI cannot
 * hear mid turn (a live one queues the line behind the turn, a
 * headless one not at all), so a second wake would be a second turn on
 * a tree the first one is still editing; and the folding is the point,
 * because five workers finishing within a minute of each other is one
 * thing the planner needs to know, not five wake ups it pays for
 * separately. A turn's end enqueues a tick, and this delivers then:
 * into the process a planner held open between turns, or as the prompt
 * of a new run when there is none.
 */
async function deliverPlannerWake(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  deps: SwarmTickDeps,
  now: Date,
  refusals: ComputeRefusal[],
  events: BoardEvent[],
): Promise<PlannerWoken | null> {
  /*
   * A swarm paused on its plan's hours is the exception to the pause:
   * a refused wake is one of the things that pauses it, and the wake
   * asking again is how it notices the hours came back.
   */
  if ((swarm.status === "paused" && !pausedOnPlanLimit(swarm)) || swarm.status === "cancelled" || swarm.status === "draft") {
    return null;
  }

  const [activePlanner] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.swarmId, swarm.id),
        eq(agentRuns.role, "planner"),
        inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .limit(1);
  /*
   * A planner held open between turns (swarm/live.ts) hears the wake
   * in the process it already has, with the session it already holds,
   * so a worker's report reaches it without a machine wake, a spawn,
   * and a session resume. Only while it is between turns: mid turn the
   * wake waits, as above, and the turn's end asks for this tick again.
   * A planner this process does not hold (another server's, or one on
   * an adapter with no live mode) is simply active, and the wake waits
   * for its run to end.
   */
  const held = activePlanner ? deps.liveInputs?.get(activePlanner.id) : undefined;
  const hearsLive = activePlanner !== undefined && held !== undefined && held.waiting?.() === true;
  if (activePlanner && !hearsLive) return null;

  /*
   * Messages handed to a planner that then failed or was stopped go
   * back in the queue. That planner never finished the turn they were
   * in, so nobody read them, and a feature card's messages have always
   * gone back the same way. Read here rather than on each path that
   * ends a run, for the reason PLANNER_NOT_TOLD is: every terminal path
   * passes through a tick, and not every one remembers to settle.
   *
   * The run stays on the row, so the wake below can tell a message that
   * is back from one that is new.
   */
  await tx
    .update(swarmMessages)
    .set({ status: "queued", sentAt: null })
    .where(
      and(
        eq(swarmMessages.swarmId, swarm.id),
        isNull(swarmMessages.taskId),
        eq(swarmMessages.status, "sent"),
        sql`exists (
          select 1 from ${agentRuns}
          where ${agentRuns.id} = ${swarmMessages.runId}
            and ${agentRuns.role} = 'planner'
            and ${agentRuns.status} in ('failed', 'cancelled')
        )`,
      ),
    );

  // Messages a person sent to the plan rather than to one leaf.
  const pending = await tx
    .select()
    .from(swarmMessages)
    .where(
      and(
        eq(swarmMessages.swarmId, swarm.id),
        isNull(swarmMessages.taskId),
        eq(swarmMessages.status, "queued"),
      ),
    )
    .orderBy(asc(swarmMessages.createdAt));

  /**
   * What the tree did while the planner was away.
   *
   * Two things count as news. A leaf that has reported, which is a
   * worker asking to be accepted or sent back, and a leaf that failed,
   * which is work the plan has to do something else about. A leaf that
   * reported is still "working" until the planner decides, so the
   * status column alone cannot find it: the report is the marker, and
   * asking for status alone was how every accepted-or-rejected decision
   * waited on a planner nobody woke.
   *
   * Done is not in the list. A leaf is done because the planner
   * accepted it, and telling an agent what it just did is a turn spent
   * on nothing.
   *
   * Leaves, said in the query rather than only in this comment. A
   * group's status is this tick's own rollup of children the planner
   * is being told about in the same message, so folding the group in
   * spends a planner turn on something it cannot act on, and burns
   * the plannerToldAt latch on a node that will never report.
   */
  const reported = await tx
    .select()
    .from(swarmTasks)
    .where(
      and(
        eq(swarmTasks.swarmId, swarm.id),
        eq(swarmTasks.nodeType, "leaf"),
        sql`(${swarmTasks.report} is not null or ${swarmTasks.status} = 'failed')`,
        sql`${swarmTasks.status} <> 'cancelled'`,
        PLANNER_NOT_TOLD,
      ),
    )
    .orderBy(asc(swarmTasks.position));

  /**
   * Not while the agent that reported is still running.
   *
   * report is a tool call, not the end of a turn, so a worker can call
   * it and go on committing for another minute. A planner told about
   * it then could accept the leaf, and the merge queue would land the
   * branch as it stood halfway through the worker's last commit. The
   * run's own settlement enqueues a tick, so waiting costs nothing.
   */
  const stillWorking = new Set(
    (
      await tx
        .select({ taskId: agentRuns.swarmTaskId })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
    )
      .map((row) => row.taskId)
      .filter((id): id is string => id !== null),
  );
  const news = reported.filter((task) => !stillWorking.has(task.id));

  /*
   * How each earlier reviewer ended, for the news and the messages that
   * are back: stopped by a person, failed, or finished without deciding.
   */
  const toldBy = news
    .map((task) => (isTold(task.flags) && typeof task.flags.plannerToldBy === "string" ? task.flags.plannerToldBy : null))
    .filter((id): id is string => id !== null);
  const earlierRuns = [...toldBy, ...pending.map((message) => message.runId).filter((id): id is string => id !== null)];
  const endedAs = new Map(
    earlierRuns.length === 0
      ? []
      : (
          await tx
            .select({ id: agentRuns.id, status: agentRuns.status })
            .from(agentRuns)
            .where(inArray(agentRuns.id, [...new Set(earlierRuns)]))
        ).map((row) => [row.id, row.status] as const),
  );

  /*
   * News whose planner a person stopped rides along and never wakes a
   * planner by itself: the stop was a choice, and a planner started on
   * the stop's own tick would make the planner impossible to stop short
   * of pausing the swarm. It goes out with the next wake that something
   * else causes (another leaf, a message from a person). A message that
   * went to that planner rides along the same way.
   */
  const stoppedBy = (runId: unknown) => typeof runId === "string" && endedAs.get(runId) === "cancelled";
  const wakes = news.some((task) => !(isTold(task.flags) && stoppedBy(task.flags.plannerToldBy)));

  /*
   * A message that is back because its planner failed wakes the next
   * one, as many times as a leaf's news would be handed over again and
   * no more: a planner that fails every turn (a refused key, a provider
   * that stays down) would otherwise be started again by its own
   * failure's tick, forever, on a message nobody can read. Past that it
   * rides along with whatever wakes the planner next.
   */
  const failedStreak = pending.some((message) => message.runId !== null && endedAs.get(message.runId) === "failed")
    ? await failedPlannerStreak(tx, swarm.id)
    : 0;
  const messageWakes = pending.some((message) => {
    if (message.runId === null) return true;
    const ended = endedAs.get(message.runId);
    if (ended === "cancelled") return false;
    if (ended === "failed") return failedStreak < MAX_PLANNER_RETELLS;
    return true;
  });

  if (!messageWakes && !wakes) return null;

  const profileId = await plannerProfileFor(tx, swarm);
  // Nothing to run the planner as. The messages stay queued, so this
  // resolves itself the moment a planner agent is set in the swarm's settings.
  if (!profileId) return null;

  /*
   * A leaf back because the planner it went to finished its turn
   * without accepting or rejecting it. Said in Bento's own words, so the
   * planner reads that its last turn left this undecided rather than
   * seeing the same report again as if it were new.
   */
  const undecided = news.filter(
    (task) =>
      isTold(task.flags) &&
      typeof task.flags.plannerToldBy === "string" &&
      endedAs.get(task.flags.plannerToldBy) === "succeeded",
  );

  const items: PlannerWakeItem[] = [
    ...news.map((task) => ({
      kind: "task" as const,
      taskId: task.id,
      title: task.title,
      status: task.status,
      report: task.report,
    })),
    ...pending.map((message) =>
      message.source === "system"
        ? ({ kind: "notice" as const, text: message.text })
        : ({ kind: "message" as const, text: message.text }),
    ),
    ...undecided.map((task) => ({
      kind: "notice" as const,
      text: `Your last turn ended without accepting or rejecting task ${task.id}, so it is still waiting on your decision. Accept it, reject it with a reason, cancel it, or ask a person about it with ask_user.`,
    })),
  ];

  let runId: string;
  if (hearsLive && activePlanner && held) {
    /*
     * Written last, after every read above, so the bookkeeping below
     * is the only thing left between the write and the commit. The
     * session can close between the waiting check and the write (the
     * hold ran out, or the run is ending); then nothing was heard, and
     * the run's settlement ticks again with everything still here.
     */
    const accepted = await held.deliver(plannerWakeMessage(items));
    if (!accepted) return null;
    runId = activePlanner.id;
  } else {
    const started = await deps.startRun(tx, {
      type: "swarm",
      swarmId: swarm.id,
      role: "planner",
      agentProfileId: profileId,
      prompt: plannerWakeMessage(items),
      // A swarm run is always this server's: a project on a runner
      // cannot have swarms at all, which the create route refuses.
      executor: "server",
      // The person whose message woke it, so their own MCP connections
      // are the ones this turn may use. Null when the tree woke it.
      startedBy: pending[0]?.userId ?? null,
    });
    // The worker ceiling is a worker's answer and never a planner's, and
    // it is folded in here so the wake stays held rather than being
    // stamped as delivered by a run that does not exist.
    if (started !== "busy" && started !== "gone" && started !== SWARM_FULL && "outOfCompute" in started) {
      refusals.push({ refusal: started.outOfCompute, cap: started.cap ?? "plan" });
      return null;
    }
    if (started === "busy" || started === "gone" || started === SWARM_FULL) return null;
    await resumeFromPlanLimit(tx, swarm, events, now);
    runId = started.id;
  }

  for (const message of pending) {
    await tx
      .update(swarmMessages)
      .set({ status: "sent", runId, sentAt: now })
      .where(eq(swarmMessages.id, message.id));
  }
  for (const task of news) {
    /*
     * A leaf that already carries a latch is back because the planner
     * it was handed to never decided it (PLANNER_NOT_TOLD let it
     * through for that reason alone). Said on the node first, so its
     * log reads as what happened: handed over, lost, handed over again.
     */
    const previousReviewer = typeof task.flags.plannerToldBy === "string" ? task.flags.plannerToldBy : null;
    const retold = previousReviewer !== null && isTold(task.flags);
    if (retold) {
      await tx.insert(swarmTaskEvents).values({
        taskId: task.id,
        kind: "review_interrupted",
        runId: previousReviewer,
        detail: {
          note:
            endedAs.get(previousReviewer) === "succeeded"
              ? "The planner reviewing this finished its turn without deciding, so it is being handed over again."
              : "The planner reviewing this ended before it decided, so a new planner is reviewing it.",
        },
      });
    }
    await tx
      .update(swarmTasks)
      // Which run was told, as well as when: PLANNER_NOT_TOLD reads a
      // leaf as not told again once that run failed or was cancelled,
      // or finished without deciding it, because such a planner never
      // dealt with this. A re-tell is counted, so the same news is
      // handed over at most MAX_PLANNER_RETELLS times.
      .set({
        flags: {
          ...task.flags,
          plannerToldAt: now.toISOString(),
          plannerToldBy: runId,
          ...(retold ? { plannerRetells: retellCount(task.flags) + 1 } : {}),
        },
      })
      .where(eq(swarmTasks.id, task.id));
    /*
     * And the handover itself, on the node's own log. Before this the
     * log went from "reported" straight to the verdict, so a worker
     * waiting on a planner looked exactly like a worker nobody was
     * looking at, which is the one difference a person needs to see.
     * The run id is the planner's, so the drawer can link its turn.
     */
    await tx.insert(swarmTaskEvents).values({
      taskId: task.id,
      kind: "review_requested",
      runId,
      detail: {
        note:
          task.status === "failed"
            ? "The planner was handed this failure to decide what happens next."
            : "The planner was handed this report to accept or send back.",
      },
    });
  }
  return { runId, live: hearsLive };
}

/** How many of this swarm's latest planner runs failed in a row. */
async function failedPlannerStreak(tx: Tx, swarmId: string): Promise<number> {
  const recent = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(and(eq(agentRuns.swarmId, swarmId), eq(agentRuns.role, "planner")))
    .orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id))
    .limit(MAX_PLANNER_RETELLS + 1);
  let streak = 0;
  for (const run of recent) {
    if (run.status !== "failed") break;
    streak += 1;
  }
  return streak;
}

/**
 * Raises attention on a leaf whose report has been handed to a planner
 * as many times as it will be, and is still undecided.
 *
 * PLANNER_NOT_TOLD stops finding such a leaf once its re-tells are
 * spent, which is right (a planner that will not decide is not woken
 * forever) and was silent: the leaf sat "working" with its report and
 * the swarm sat "running" with nothing moving. Attention is what turns
 * the swarm's headline to blocked, so the board says a person has to
 * accept, retry, or cancel it. Once: a leaf whose attention is already
 * set is not found again.
 */
async function flagUndecidedLeaves(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  events: BoardEvent[],
  now: Date,
): Promise<void> {
  if (swarmIsOver(swarm.status) || swarm.status === "draft") return;
  const stuck = await tx
    .update(swarmTasks)
    .set({ attention: "failed", updatedAt: now })
    .where(and(eq(swarmTasks.swarmId, swarm.id), PLANNER_RETELLS_EXHAUSTED))
    .returning({ id: swarmTasks.id, flags: swarmTasks.flags });
  for (const row of stuck) {
    await tx.insert(swarmTaskEvents).values({
      taskId: row.id,
      kind: "attention_raised",
      detail: {
        reason: "planner_undecided",
        retells: retellCount(row.flags),
        note: "The planner was handed this report several times and never accepted or rejected it. Accept, retry, or cancel it.",
      },
    });
    const task = tasks.find((candidate) => candidate.id === row.id);
    if (task) task.attention = "failed";
    events.push({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: row.id,
      status: "working",
    });
  }
}

/** Whether the swarm is paused waiting for its plan's hours, the one pause nobody chose. */
function pausedOnPlanLimit(swarm: typeof swarms.$inferSelect): boolean {
  return swarm.status === "paused" && swarm.pausedReason === "plan_limit";
}

/**
 * Takes a swarm out of a plan limit pause once something started.
 *
 * The spawn step writes this itself for a worker; a planner or a
 * resolver started on a paused swarm needs the same, or the board goes
 * on saying the team is out of hours while the agent works. Only the
 * plan limit: a person's pause and the endings are not this step's.
 */
async function resumeFromPlanLimit(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  events: BoardEvent[],
  now: Date,
): Promise<void> {
  if (!pausedOnPlanLimit(swarm)) return;
  await tx
    .update(swarms)
    .set({ status: "running", pausedReason: null, updatedAt: now })
    .where(and(eq(swarms.id, swarm.id), eq(swarms.status, "paused"), eq(swarms.pausedReason, "plan_limit")));
  swarm.status = "running";
  swarm.pausedReason = null;
  events.push({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id, status: "running" });
}

/**
 * Tells the planner about open leaves once the swarm has nothing else
 * to do.
 *
 * create_task and split_task make open leaves, and the spawn step only
 * starts assigned ones. Open is deliberate: it is a leaf nobody has
 * approved yet (the planner assigns what should run, and Start or
 * Resume approves what it left open in a saved plan), so the tick does
 * not start one by itself. What was missing is anyone hearing about
 * it. A planner that ended its turn with leaves open left a started
 * swarm "running" with work in its tree, nothing that would ever start
 * it, and no event coming, because Start had been pressed already.
 *
 * So once the swarm is otherwise idle (no agent of any kind running,
 * nothing in the merge queue, no leaf assigned or in flight), the
 * planner is told which leaves are still open, in a notice the wake
 * folds into its next turn, and decides: assign, cancel, or ask a
 * person. Once per leaf, latched on the leaf, so a planner that leaves
 * one open on purpose is not woken about it every tick. While anything
 * moves an open leaf may be the planner holding work back until it has
 * seen a result, which is its call, so nothing is said.
 */
async function noticeIdleOpenLeaves(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  now: Date,
): Promise<void> {
  if (swarm.status !== "running" && swarm.status !== "blocked") return;
  const open = tasks.filter(
    (task) =>
      task.nodeType === "leaf" &&
      task.status === "open" &&
      task.attention === null &&
      typeof task.flags[OPEN_NOTICED_FLAG] !== "string",
  );
  if (open.length === 0) return;
  if (
    tasks.some(
      (task) =>
        task.nodeType === "leaf" &&
        (task.status === "assigned" || task.status === "working" || task.status === "landed"),
    )
  ) {
    return;
  }
  if (await swarmHasActiveRun(tx as unknown as Db, swarm.id)) return;
  const [landing] = await tx
    .select({ id: swarmLandings.id })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.swarmId, swarm.id), inArray(swarmLandings.status, ["queued", "landing", "conflicted"])))
    .limit(1);
  if (landing) return;

  await tx.insert(swarmMessages).values({
    swarmId: swarm.id,
    source: "system",
    text: [
      `Nothing in this swarm is running, and ${open.length === 1 ? "this task is" : "these tasks are"} still open, so no agent will start on ${open.length === 1 ? "it" : "them"} until you assign ${open.length === 1 ? "it" : "them"}:`,
      ...open.map((task) => `Task ${task.id}, titled:\n${quoteUntrusted(task.title)}`),
      "Assign the ones that should run now, cancel the ones that should not, or ask_user if a person has to decide. Anything you leave open stays open.",
    ].join("\n"),
  });
  for (const task of open) {
    const flags = { ...task.flags, [OPEN_NOTICED_FLAG]: now.toISOString() };
    await tx.update(swarmTasks).set({ flags }).where(eq(swarmTasks.id, task.id));
    task.flags = flags;
  }
}

/** Where an open leaf records that the planner was told it was waiting. */
const OPEN_NOTICED_FLAG = "openNoticedAt";

/** The agent the planner runs as, chosen when the swarm was created. */
async function plannerProfileFor(_tx: Tx, swarm: typeof swarms.$inferSelect): Promise<string | null> {
  return swarm.plannerProfileId;
}

/** The agent every leaf runs as unless a person reassigned it. */
async function workerProfileFor(_tx: Tx, swarm: typeof swarms.$inferSelect): Promise<string | null> {
  return swarm.workerProfileId;
}

/* ------------------------------------------------------------------ *
 * Step 3: spawn workers on ready leaves.
 * ------------------------------------------------------------------ */

interface SpawnResult {
  runIds: string[];
  refusal: string | null;
  /** Which ceiling refused, so step five knows which ending this is. */
  cap: "plan" | "budget" | null;
}

/** A ceiling that refused a planner, a sub planner or a resolver. */
interface ComputeRefusal {
  refusal: string;
  cap: "plan" | "budget";
}

/**
 * The spawn step's answer, with the other roles' refusals folded in.
 *
 * Only for a swarm that spawns at all (see spawnsFrom), so a refusal
 * means here what a worker's means: the swarm pauses on the plan's
 * hours or ends on its budget once nothing is running. A planning
 * swarm is left alone, because a pause it could leave by spawning
 * would start workers on a plan nobody approved; an ended one keeps
 * its ending. The worker's own refusal is the first word when there is
 * one, because it is the one written on a leaf.
 */
function withRefusals(swarm: typeof swarms.$inferSelect, spawned: SpawnResult, refusals: ComputeRefusal[]): SpawnResult {
  if (spawned.refusal || refusals.length === 0 || !spawnsFrom(swarm)) return spawned;
  const first = refusals.find((refusal) => refusal.cap === "budget") ?? refusals[0]!;
  return { ...spawned, refusal: first.refusal, cap: first.cap };
}

/**
 * The states a swarm spawns from.
 *
 * The two stalled ones are in the list on purpose, and they are what
 * makes a ceiling temporary rather than terminal. A swarm paused
 * because the team ran out of agent hours starts again when the period
 * rolls over, and one that stopped on its budget starts again when
 * somebody raises it. Neither is an event anything fires on, so the
 * answer is to try the spawn and let the door say yes or no: the
 * watchdog re-ticks these swarms for exactly this step.
 *
 * Cancelled, done and failed are not here. Those are endings.
 */
function spawnsFrom(swarm: typeof swarms.$inferSelect): boolean {
  if (swarm.status === "running" || swarm.status === "blocked") return true;
  /*
   * Both ceiling endings, not just the money one. They are the same
   * shape: a ceiling a person raises to reopen, where the raise is the
   * only event that ever lifts it. A swarm whose time limit had been
   * raised used to tick and start nothing, so the ending a person was
   * offered a Resume button on was the one ending they could not leave.
   */
  if (swarm.status === "budget_exhausted" || swarm.status === "timed_out") return true;
  return swarm.status === "paused" && swarm.pausedReason === "plan_limit";
}

/**
 * The sentence a ceiling wrote on a leaf it refused to start, which
 * stops being true the moment that leaf starts.
 *
 * Read and removed rather than overwritten with null, because the
 * drawer lists whatever keys a leaf's flags carry: a key set to null
 * is still a line on the screen.
 */
function hasSpawnRefusal(flags: unknown): boolean {
  return typeof flags === "object" && flags !== null && "spawnRefusal" in flags;
}

function withoutSpawnRefusal(flags: unknown): Record<string, unknown> {
  const { spawnRefusal: _dropped, ...rest } = (flags ?? {}) as Record<string, unknown>;
  return rest;
}

/** A dependent leaf waits until every prerequisite above it has finished. */
export function leafAncestorsDone(task: Task, byId: Map<string, Task>): boolean {
  const seen = new Set<string>([task.id]);
  let current = task;
  while (current.parentId) {
    const parentId = current.parentId;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (current.parentRelation === "depends_on" && parent.status !== "done") return false;
    current = parent;
  }
  return true;
}

/**
 * Puts an agent on every ready leaf the swarm still has room for.
 *
 * The ceiling is not counted here: startRunIfIdle counts it under the
 * swarm's lock, and a "busy" answer is how this loop learns the swarm
 * is full. Doing the arithmetic here as well would be a second opinion
 * that can disagree with the one that actually decides.
 *
 * A plan limit stops the loop rather than failing the tick, and the
 * reason is written onto the leaf that hit it. A tick that threw would
 * be retried by pg-boss into the same refusal, and the person would
 * see a swarm that is stuck with nothing saying why; a leaf marked
 * "needs attention: budget" says it on the board.
 */
async function spawnWorkers(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  deps: SwarmTickDeps,
  events: BoardEvent[],
  now: Date,
): Promise<SpawnResult> {
  const runIds: string[] = [];
  /**
   * Only a swarm somebody started. A plan being written is not work to
   * do: the planner is still deciding what the leaves are, and a
   * person has not yet said go. That is the whole content of the start
   * route, and it is enforced here rather than there, because the
   * coordinator is what would otherwise spawn regardless.
   *
   * A swarm stalled on a ceiling is included, because trying is how a
   * ceiling that has lifted is noticed. See spawnsFrom.
   */
  if (!spawnsFrom(swarm)) return { runIds, refusal: null, cap: null };

  /*
   * A plan node the planner handed over, before the leaves.
   *
   * Before, because a sub planner produces leaves and a leaf takes a
   * worker slot for as long as an agent is on it: starting the planner
   * of a subtree first is what lets the leaves it writes be picked up
   * on the next tick rather than a tick after every other leaf has
   * finished.
   *
   * The depth ceiling is the swarm's, and it is checked at the tool
   * that marks the node rather than here as well: this step starts
   * what was marked, and two opinions about how deep a plan may go is
   * how they come to differ.
   */
  const delegated = await spawnSubPlanners(tx, swarm, tasks, deps, events, now);
  runIds.push(...delegated.runIds);
  /*
   * A sub planner a ceiling refused is reported here only when no leaf
   * reports one below: the leaf is where the sentence belongs, but a
   * swarm whose only waiting work was a plan node used to sit "running"
   * with nothing starting and nothing saying why.
   */
  const quiet: SpawnResult = delegated.refusal
    ? { runIds, refusal: delegated.refusal.refusal, cap: delegated.refusal.cap }
    : { runIds, refusal: null, cap: null };

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ready = tasks.filter(
    (task) => task.nodeType === "leaf" && task.status === "assigned" &&
      // Starting over: its old machine is being taken down first.
      !(task.flags as { startingOver?: boolean }).startingOver &&
      !isDocumentAssembly(task) && leafAncestorsDone(task, byId),
  );
  if (ready.length === 0) {
    if (runIds.length > 0) await leaveStall(tx, swarm, events, now);
    return quiet;
  }

  const swarmWorker = await workerProfileFor(tx, swarm);

  for (const task of ready) {
    /*
     * The agent a person chose for this leaf, or the swarm's.
     *
     * Reassigning a leaf that a cheap worker could not finish writes
     * the choice on the node, so it survives a retry and does not
     * change the agent every other leaf gets.
     */
    const profileId = task.agentProfileId ?? swarmWorker;
    /*
     * Nothing to run this one as. The leaf keeps its place in the
     * queue and starts the moment a worker agent is set in the
     * swarm's settings, and its siblings are still this tick's to
     * start: a leaf somebody reassigned by hand has an agent of its
     * own, and a swarm with no worker must not hold it up.
     */
    if (!profileId) continue;
    const started = await deps.startRun(tx, {
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: task.id,
      /*
       * The final check is a judge, and the role says so on the run.
       * It is what the executor reads to give it the judge's prompt
       * rather than a worker's, and it is what makes the run legible
       * afterwards: an agent that changed nothing and ruled on the
       * work is not a worker, whatever table it shares.
       */
      role: isFinalCheck(task) ? "judge" : "worker",
      agentProfileId: profileId,
      prompt: "",
      executor: "server",
      startedBy: swarm.startedBy,
    });
    /*
     * The swarm is at its ceiling, so there is no room for the leaves
     * behind this one either. This is the only refusal that means
     * that: "busy" is an answer about one leaf (something is already
     * on it, which says nothing about its siblings), and the two were
     * one word until a single leaf with a run on it held up every
     * other ready leaf until the next tick.
     */
    if (started === SWARM_FULL) break;
    // Something is already working this leaf. Its siblings are still
    // this tick's to start.
    if (started === "busy") continue;
    // The swarm row went while this tick was running, so there is
    // nothing left to spawn on at all.
    if (started === "gone") break;
    if ("outOfCompute" in started) {
      /*
       * Which ceiling it was, said on the leaf. The two are different
       * sentences to the person looking at the board and different
       * next steps: agent hours come back on their own, and a dollar
       * budget is raised by somebody.
       */
      const attention = started.cap === "budget" ? "budget" : "plan_limit";
      await tx
        .update(swarmTasks)
        .set({
          attention,
          flags: { ...task.flags, spawnRefusal: started.outOfCompute },
          updatedAt: now,
        })
        .where(eq(swarmTasks.id, task.id));
      await tx.insert(swarmTaskEvents).values({
        taskId: task.id,
        kind: "attention_raised",
        detail: { reason: started.outOfCompute, cap: started.cap ?? "plan" },
      });
      // The in-memory row too, so step five sees the attention this
      // step just raised rather than the tree as it was before it.
      task.attention = attention;
      events.push({
        type: "swarm_task_updated",
        projectId: swarm.projectId,
        swarmId: swarm.id,
        taskId: task.id,
        status: task.status,
      });
      return { runIds, refusal: started.outOfCompute, cap: started.cap ?? "plan" };
    }

    await tx
      .update(swarmTasks)
      .set({
        status: "working",
        assignedRunId: started.id,
        /*
         * And the ceiling's mark comes off, because a leaf that just
         * started is no longer waiting for one. Only that mark: a
         * question or a conflict on this leaf is somebody else's to
         * clear.
         *
         * Both halves of it. The sentence the refusal wrote is a flag,
         * and the drawer prints the flags verbatim, so a leaf with an
         * agent on it went on saying the team was out of agent hours,
         * and said it through every later retry because a retry carries
         * the flags forward.
         */
        ...(task.attention === "budget" || task.attention === "plan_limit" ? { attention: null } : {}),
        ...(hasSpawnRefusal(task.flags) ? { flags: withoutSpawnRefusal(task.flags) } : {}),
        startedAt: task.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(swarmTasks.id, task.id));
    await tx.insert(swarmTaskEvents).values({
      taskId: task.id,
      kind: "assigned",
      fromStatus: task.status,
      toStatus: "working",
      runId: started.id,
    });
    task.status = "working";
    if (task.attention === "budget" || task.attention === "plan_limit") task.attention = null;
    if (hasSpawnRefusal(task.flags)) task.flags = withoutSpawnRefusal(task.flags);
    runIds.push(started.id);
    events.push({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "working",
    });
  }

  /**
   * A stalled swarm that just started something is not stalled.
   *
   * Written here rather than left to step five, because step five
   * deliberately never recomputes a swarm out of a state a person or a
   * ceiling put it in: without this the ceiling would lift, a worker
   * would start, and the board would go on saying the swarm was out of
   * money while its agents worked.
   */
  if (runIds.length > 0) await leaveStall(tx, swarm, events, now);
  return quiet;
}

/** Moves a stalled swarm that just started something back to running. See above. */
async function leaveStall(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  events: BoardEvent[],
  now: Date,
): Promise<void> {
  if (swarm.status === "running" || swarm.status === "blocked") return;
  await tx
    .update(swarms)
    .set({ status: "running", pausedReason: null, updatedAt: now })
    .where(eq(swarms.id, swarm.id));
  swarm.status = "running";
  swarm.pausedReason = null;
  events.push({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id, status: "running" });
}


/**
 * Puts a planner on every plan node that was handed over.
 *
 * A sub planner is given one node and the subtree under it, and the
 * MCP server is what holds it to that: every tool call it makes is
 * checked against the task its run names. So there is nothing to
 * scope here beyond starting the run with that task on it.
 *
 * It runs as the swarm's own planner agent, not the worker's. What is
 * being asked for is a plan, and a swarm that pairs a strong
 * planner with a cheap worker means exactly that.
 *
 * A refusal writes nothing on the node. The node keeps its place and
 * starts when the swarm has room, the same way a leaf does, and the
 * ceiling that refused it is returned so the swarm's status says it.
 */
async function spawnSubPlanners(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  deps: SwarmTickDeps,
  events: BoardEvent[],
  now: Date,
): Promise<{ runIds: string[]; refusal: ComputeRefusal | null }> {
  const handed = tasks.filter((task) => task.nodeType === "plan" && task.status === "assigned");
  if (handed.length === 0) return { runIds: [], refusal: null };

  const profileId = await plannerProfileFor(tx, swarm);
  // Nothing to run a planner as. The node keeps its place, and starts
  // the moment a planner agent is set in the swarm's settings.
  if (!profileId) return { runIds: [], refusal: null };

  const runIds: string[] = [];
  for (const task of handed) {
    const started = await deps.startRun(tx, {
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: task.id,
      role: "subplanner",
      agentProfileId: profileId,
      prompt: "",
      executor: "server",
      startedBy: swarm.startedBy,
    });
    // The swarm is at its ceiling, so there is no room for the nodes
    // behind this one either.
    if (started === SWARM_FULL) break;
    // Something is already planning this node. Its siblings are still
    // this tick's to start.
    if (started === "busy") continue;
    if (started === "gone") break;
    /*
     * A ceiling refused it. Left to the leaf spawn below to write on a
     * leaf, which is where the sentence about it belongs: a person
     * reading the board wants one node saying the swarm is out of
     * money, not every node that was waiting.
     */
    if ("outOfCompute" in started) {
      return { runIds, refusal: { refusal: started.outOfCompute, cap: started.cap ?? "plan" } };
    }

    await tx
      .update(swarmTasks)
      .set({ status: "working", assignedRunId: started.id, startedAt: task.startedAt ?? now, updatedAt: now })
      .where(eq(swarmTasks.id, task.id));
    await tx.insert(swarmTaskEvents).values({
      taskId: task.id,
      kind: "assigned",
      fromStatus: task.status,
      toStatus: "working",
      runId: started.id,
      detail: { subplanner: true },
    });
    task.status = "working";
    runIds.push(started.id);
    events.push({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "working",
    });
  }
  return { runIds, refusal: null };
}

/* ------------------------------------------------------------------ *
 * Step 4: advance the landing queue.
 * ------------------------------------------------------------------ */

/** What step four did: the row in flight, and the agents it put on conflicts. */
interface LandingStep {
  landing: { id: string; promoted: boolean } | null;
  /** Resolver runs this tick started. A run with no job never starts. */
  resolverRunIds: string[];
}

/**
 * Keeps the merge queue honest, and hands its front row to whatever
 * lands branches.
 *
 * One landing at a time is a database fact (the partial unique index on
 * swarm_landings), not a property of this function, so most of this is
 * deciding which row is next and dropping the ones whose work went
 * away.
 *
 * The exception is a conflicted row, which is the one state in the
 * queue that needs something started rather than something chosen. A
 * conflict holds everything behind it until an agent reconciles the
 * branch, so this is where that agent is put on it: every pass, for
 * every conflicted row that has nobody, rather than once at the moment
 * the conflict was found. The difference is the whole of a queue that
 * stops for good and one that does not. A team at its plan limit is the
 * routine way a resolver cannot start, and it is transient, so the
 * answer is to ask again next pass; a conflict nothing could ever
 * resolve fails the leaf instead, which frees the queue and puts the
 * leaf in front of the planner.
 */
async function advanceLandingQueue(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  deps: SwarmTickDeps,
  events: BoardEvent[],
  now: Date,
  canStartAgents: boolean,
  refusals: ComputeRefusal[],
): Promise<LandingStep> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const resolverRunIds: string[] = [];
  const queue = await tx
    .select()
    .from(swarmLandings)
    .where(eq(swarmLandings.swarmId, swarm.id))
    .orderBy(asc(swarmLandings.position), asc(swarmLandings.createdAt));

  /**
   * A landing for work nobody is waiting to land has nothing left to
   * land.
   *
   * Conflicted as well as queued, because a conflicted row holds the
   * queue: a leaf cancelled while its branch was in conflict would
   * otherwise stop every landing behind it with nothing left that could
   * ever settle it.
   *
   * And not only a withdrawn leaf. A row is the planner's acceptance of
   * one branch, so it stands only while that acceptance does: a leaf a
   * person retried (back to assigned, a new attempt coming), marked
   * done, or that lost its acceptance some other way would otherwise
   * land a branch nobody accepted, or overwrite a person's decision
   * with the landing's. See landingStillWanted.
   */
  for (const landing of queue) {
    if (landing.status !== "queued" && landing.status !== "conflicted") continue;
    const task = byId.get(landing.taskId);
    if (task && landingStillWanted(task)) continue;
    await tx
      .update(swarmLandings)
      .set({ status: "cancelled", endedAt: now, updatedAt: now })
      .where(eq(swarmLandings.id, landing.id));
    landing.status = "cancelled";
  }

  const inFlight = queue.find((landing) => landing.status === "landing");
  if (inFlight) {
    /*
     * A landing whose job is gone. The row says "landing" for as long
     * as nothing finishes it, and the partial unique index refuses
     * every other landing in this swarm meanwhile; a job that pg-boss
     * gave up on (it threw past its retries, or expired with a process
     * that died) left exactly that, until a reboot's
     * resumeClaimedLandings. Past the job's own expiry the claim is
     * taken again and the job sent again. Running it twice is safe: the
     * branch moves by compare and swap, and every outcome is written
     * through claimOutcome, which a second writer loses.
     *
     * Counted as an attempt, so a landing whose job dies every time
     * fails after the same five a moved branch gets, rather than being
     * tried every few minutes forever.
     */
    const stale = inFlight.startedAt !== null && inFlight.startedAt.getTime() <= now.getTime() - LANDING_STALE_MS;
    if (!stale || !deps.startLanding) return { landing: { id: inFlight.id, promoted: false }, resolverRunIds };
    if (inFlight.attempt >= MAX_LANDING_ATTEMPTS) {
      await failStaleLanding(tx, swarm, inFlight, byId.get(inFlight.taskId), events, now);
      return { landing: null, resolverRunIds };
    }
    const [reclaimed] = await tx
      .update(swarmLandings)
      .set({ startedAt: now, attempt: inFlight.attempt + 1, updatedAt: now })
      .where(
        and(
          eq(swarmLandings.id, inFlight.id),
          eq(swarmLandings.status, "landing"),
          eq(swarmLandings.attempt, inFlight.attempt),
        ),
      )
      .returning({ id: swarmLandings.id });
    if (!reclaimed) return { landing: { id: inFlight.id, promoted: false }, resolverRunIds };
    await deps.startLanding(tx, inFlight.id);
    return { landing: { id: inFlight.id, promoted: true }, resolverRunIds };
  }

  const conflicts = queue.filter((landing) => landing.status === "conflicted");
  for (const landing of conflicts) {
    /**
     * A conflict whose resolver never started its agent. The machine it
     * was given could not be made, or went away before the agent ran,
     * which is the sandbox's failure and not the resolver's: it did not
     * try the conflict, so it is not the conflict's one try. The row
     * stays conflicted with nobody on it, and the step below puts
     * another resolver on it, as many times as a worker whose machine
     * failed is started again.
     */
    if (landing.resolverRunId) {
      const [resolver] = await tx
        .select({ status: agentRuns.status, error: agentRuns.error })
        .from(agentRuns)
        .where(eq(agentRuns.id, landing.resolverRunId))
        .limit(1);
      const task = byId.get(landing.taskId);
      const restarts = resolverRestarts(task?.flags);
      if (resolver && failedBeforeAgentStarted(resolver) && task && restarts < MAX_SANDBOX_RESTARTS) {
        const flags = { ...task.flags, [RESOLVER_RESTARTS_FLAG]: restarts + 1 };
        await tx
          .update(swarmLandings)
          .set({ resolverRunId: null, updatedAt: now })
          .where(and(eq(swarmLandings.id, landing.id), eq(swarmLandings.status, "conflicted")));
        await tx.update(swarmTasks).set({ flags, updatedAt: now }).where(eq(swarmTasks.id, task.id));
        await tx.insert(swarmTaskEvents).values({
          taskId: task.id,
          kind: "note",
          runId: landing.resolverRunId,
          detail: { reason: "sandbox", resolver: "restarting", restart: restarts + 1, of: MAX_SANDBOX_RESTARTS, error: resolver.error },
        });
        task.flags = flags;
        landing.resolverRunId = null;
      }
    }
    /**
     * A conflict with nobody on it. Either an agent can be started on
     * it now, or this is a conflict nothing will ever resolve and the
     * leaf fails; the one thing that must not happen is the row being
     * left exactly as it is, because nothing else in the swarm moves it
     * and everything behind it waits on it.
     */
    if (!landing.resolverRunId) {
      // The queue still moves. Only the agent that would reconcile a
      // conflict waits, for the same reason a worker is not spawned.
      if (!canStartAgents) continue;
      const runId = await startResolver(tx, swarm, landing, byId.get(landing.taskId), deps, events, now, refusals);
      if (runId) resolverRunIds.push(runId);
      continue;
    }
    /**
     * A conflict whose resolver has finished is ready to be tried
     * again.
     *
     * Without this the queue stops for good. The landing sits at
     * "conflicted", which holds everything behind it, the resolver run
     * ends and settles into a tick, and the tick reads a conflicted row
     * and returns: nothing anywhere moves the row back, so a swarm's
     * first conflict was the last thing it ever did. The resolver is
     * what changes the facts (it merges the swarm's branch into the
     * leaf's and resolves), so its ending is exactly when the row is
     * worth promoting again.
     *
     * The resolver run id stays on the row, which is what makes this
     * happen once: performLanding fails a leaf whose landing already
     * names a resolver, rather than asking for a second one.
     */
    const [resolver] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, landing.resolverRunId))
      .limit(1);
    if (resolver && (ACTIVE_RUN_STATUSES as readonly string[]).includes(resolver.status)) continue;
    await tx
      .update(swarmLandings)
      .set({ status: "queued", startedAt: null, updatedAt: now })
      .where(eq(swarmLandings.id, landing.id));
    landing.status = "queued";
  }
  /**
   * A conflict still being resolved holds the queue: landing the row
   * behind it would put the conflicted branch permanently out of order
   * with work that passed it. Either the resolver settles it or the
   * leaf fails, and both go through the row.
   */
  if (queue.some((landing) => landing.status === "conflicted")) return { landing: null, resolverRunIds };

  /*
   * A landing waiting out a backoff lets the ones behind it go first:
   * they are other leaves' independent work, and a sandbox one leaf
   * cannot reach is no reason to stop the whole queue. A dependent
   * leaf cannot be queued behind its dependency, because it only
   * starts once that one has landed.
   *
   * With a little grace: the backoff was written by one host's clock
   * and the tick that ends it is fired by the database's, so a tick a
   * second early would otherwise find the row not yet due and leave it
   * for whatever ticks next.
   */
  const next = queue.find(
    (landing) =>
      landing.status === "queued" &&
      (!landing.notBefore || landing.notBefore.getTime() <= now.getTime() + LANDING_BACKOFF_GRACE_MS),
  );
  // Nothing performs landings in this deployment yet. Promoting the row
  // would move it into a state nothing takes it out of, so the queue is
  // left as it is and the row keeps its place.
  if (!next || !deps.startLanding) return { landing: null, resolverRunIds };

  await tx
    .update(swarmLandings)
    .set({ status: "landing", startedAt: now, notBefore: null, attempt: next.attempt + 1, updatedAt: now })
    .where(eq(swarmLandings.id, next.id));
  await deps.startLanding(tx, next.id);
  return { landing: { id: next.id, promoted: true }, resolverRunIds };
}

/**
 * How long a landing may say "landing" before its job is presumed
 * gone: the land job's expiry (pg-boss's fifteen minute default, which
 * the queue does not change) and five minutes on top.
 */
const LANDING_STALE_MS = 20 * 60_000;

/** How early a tick may arrive for a landing's backoff and still promote it. */
const LANDING_BACKOFF_GRACE_MS = 5_000;

/** Where a leaf counts resolvers whose machine could not be made. */
const RESOLVER_RESTARTS_FLAG = "resolverRestarts";

function resolverRestarts(flags: unknown): number {
  const value = typeof flags === "object" && flags !== null ? (flags as Record<string, unknown>)[RESOLVER_RESTARTS_FLAG] : 0;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Whether a merge queue row is still wanted by its leaf.
 *
 * The row is the planner's acceptance of a branch, so it stands while
 * the leaf is accepted and still in flight ("working" until it lands),
 * or "landed", which is where a person's merge queue retry puts it.
 * A leaf that went back to assigned (retried or started over), was
 * marked done or cancelled by a person, or failed has moved on, and a
 * landing for it would land a branch nobody accepted.
 */
function landingStillWanted(task: Task): boolean {
  if (task.status === "landed") return true;
  return task.status === "working" && task.flags.accepted === true;
}

/**
 * Fails a landing whose job kept dying, from the tick, the way the
 * landing would fail itself once its attempts are spent.
 */
async function failStaleLanding(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  landing: typeof swarmLandings.$inferSelect,
  task: Task | undefined,
  events: BoardEvent[],
  now: Date,
): Promise<void> {
  const reason = `the merge queue started this landing ${landing.attempt} times and it never finished.`;
  const [failed] = await tx
    .update(swarmLandings)
    .set({ status: "failed", error: reason, errorCode: "attempts_exhausted", endedAt: now, updatedAt: now })
    .where(and(eq(swarmLandings.id, landing.id), eq(swarmLandings.status, "landing")))
    .returning({ id: swarmLandings.id });
  if (!failed || !task || task.status === "done" || task.status === "cancelled") return;
  await handLeafToPlanner(tx, {
    task,
    status: "failed",
    attention: "failed",
    flags: { landingError: reason, landingErrorCode: "attempts_exhausted" },
    detail: { landingError: reason, landingErrorCode: "attempts_exhausted" },
    now,
  });
  task.status = "failed";
  task.attention = "failed";
  events.push({
    type: "swarm_task_updated",
    projectId: swarm.projectId,
    swarmId: swarm.id,
    taskId: task.id,
    status: "failed",
  });
}

/**
 * Puts an agent on one conflicted landing, or fails the leaf when
 * nothing could be put on it.
 *
 * Returns the run it started, so the caller can hand it to the queue
 * after the commit: a run row with no `run.execute` job is a resolver
 * that never runs and a queue that never moves.
 *
 * Refusals are not all the same, and the difference is what this is
 * for. No worker agent on the swarm is permanent, so the leaf fails
 * with a sentence a person can act on. "Busy" and a plan limit are
 * transient: the row is left conflicted with nobody on it, and the next
 * tick asks again.
 */
async function startResolver(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  landing: typeof swarmLandings.$inferSelect,
  task: Task | undefined,
  deps: SwarmTickDeps,
  events: BoardEvent[],
  now: Date,
  refusals: ComputeRefusal[],
): Promise<string | null> {
  // A row whose leaf is gone is the cancel sweep's, not this one's.
  if (!task || task.status === "cancelled") return null;

  const profileId = await workerProfileFor(tx, swarm);
  if (!profileId) {
    const reason =
      "this swarm has no worker agent, so nothing can be put on the conflict. Choose one in the swarm's settings, and the planner can hand this work out again.";
    await tx
      .update(swarmLandings)
      .set({
        status: "failed",
        error: [landing.error, "", reason].filter((line) => line !== null).join("\n"),
        errorCode: "conflict_unresolved",
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(swarmLandings.id, landing.id));
    await handLeafToPlanner(tx, {
      task,
      status: "failed",
      attention: "conflict",
      flags: { landingError: reason, landingErrorCode: "conflict_unresolved" },
      detail: { landingError: reason, landingErrorCode: "conflict_unresolved" },
      now,
    });
    // The rows this tick's later steps read, and the row the queue
    // above reads: both have to see the conflict gone, or the queue
    // stays held for one more pass by a landing that has failed.
    landing.status = "failed";
    task.status = "failed";
    task.attention = "conflict";
    events.push({
      type: "swarm_task_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      taskId: task.id,
      status: "failed",
    });
    return null;
  }

  const started = await deps.startRun(tx, {
    type: "swarm",
    swarmId: swarm.id,
    swarmTaskId: task.id,
    role: "resolver",
    agentProfileId: profileId,
    prompt: "",
    executor: "server",
    startedBy: swarm.startedBy,
  });
  // SWARM_FULL is the swarm's ceiling and belongs here with the rest:
  // a resolver asked for while every slot is taken is asked for again
  // on the next tick, which is the whole point of starting it from the
  // reconciler rather than from the landing that conflicted.
  if (started !== "busy" && started !== "gone" && started !== SWARM_FULL && "outOfCompute" in started) {
    // Asked for again next pass, and said on the swarm meanwhile: a
    // conflict waiting on the plan's hours holds the whole queue.
    refusals.push({ refusal: started.outOfCompute, cap: started.cap ?? "plan" });
    return null;
  }
  if (started === "busy" || started === "gone" || started === SWARM_FULL) return null;
  await resumeFromPlanLimit(tx, swarm, events, now);

  await tx
    .update(swarmLandings)
    .set({ resolverRunId: started.id, updatedAt: now })
    .where(eq(swarmLandings.id, landing.id));
  await tx.insert(swarmTaskEvents).values({
    taskId: task.id,
    kind: "attention_raised",
    runId: started.id,
    detail: { conflict: landing.error, resolver: "started" },
  });
  landing.resolverRunId = started.id;
  return started.id;
}

/* ------------------------------------------------------------------ *
 * Step 5: recompute the swarm's own status.
 * ------------------------------------------------------------------ */

/**
 * The swarm's status, from its tree.
 *
 * Four states belong to a person rather than to the tree, and are never
 * recomputed: draft (made, not started), planning (the planner is
 * writing the plan and nobody has said go), paused, and cancelled.
 *
 * planning is in that list for a reason worth stating. A started swarm
 * whose leaves are all still pending looks exactly like a swarm being
 * planned, so a rule read off the tree alone would move it back to
 * planning the moment it started, and the coordinator would then refuse
 * to spawn on it forever. Which side of the start button a swarm is on
 * is not something its tasks can answer.
 */
export function swarmStatusFrom(
  current: (typeof swarms.$inferSelect)["status"],
  roots: TaskStatus[],
  /**
   * Why a paused swarm is paused, which decides whether the tree may
   * finish it. A ceiling's pause is nobody's choice; a person's is.
   */
  pausedReason?: (typeof swarms.$inferSelect)["pausedReason"],
): (typeof swarms.$inferSelect)["status"] {
  if (current === "draft" || current === "planning" || current === "cancelled") {
    return current;
  }
  // Started, with nothing in the plan to summarize.
  if (roots.length === 0) return current;
  const rolled = rollUpStatus("open", roots);
  /*
   * The three ceilings hold a swarm still, but they do not make it
   * unfinishable.
   *
   * A swarm stopped by its budget, its clock or its plan's hours has a
   * tree full of open leaves, which reads as a swarm at work, so none
   * of them is recomputed away by the rollup: only a spawn that
   * succeeds takes it out, and the spawn step writes that itself.
   *
   * Except when the tree actually finished. Nothing is killed for any
   * ceiling, so the workers that were running when it was reached go
   * on to land their branches, and those landings can be the last work
   * the plan had. A swarm whose every task is done is done, whatever
   * stopped it starting more, and without this it would sit at "out of
   * budget" over a finished tree, publish nothing, and wait for a
   * person to notice.
   *
   * The plan limit is the one this matters most for. The other two are
   * endings a person can see and reopen; a plan limit is a pause that
   * only the watchdog is still looking at, so a finished tree left
   * under one is a branch that is never pushed and a pull request that
   * is never opened, with a job a minute asking about it for good.
   */
  if (current === "paused") {
    return pausedReason === "plan_limit" && rolled === "done" ? "done" : current;
  }
  if (current === "budget_exhausted" || current === "timed_out") {
    return rolled === "done" ? "done" : current;
  }
  switch (rolled) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    default:
      // Working, or waiting for a worker slot. Both are a swarm at work.
      return "running";
  }
}

async function recomputeSwarmStatus(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  events: BoardEvent[],
  spawn: SpawnResult,
): Promise<(typeof swarms.$inferSelect)["status"]> {
  /**
   * A ceiling that refused a spawn ends the swarm once nothing is
   * left running, and not a moment before.
   *
   * Nothing is killed for either ceiling: the workers that are mid task
   * finish and their branches land, which is the same rule a card
   * follows and the reason the two are separate questions. It is only
   * when the last of them has stopped that a swarm nobody can spawn on
   * is actually over.
   *
   * The two endings are different states because they are different
   * things to do next. Out of agent hours is the team's plan and comes
   * back on its own, so the swarm is paused with the reason on it and
   * the watchdog keeps asking. Out of budget is this swarm's own cap
   * and comes back only when a person raises it, so it is an ending
   * that keeps everything that landed and can be reopened.
   */
  if (spawn.refusal) {
    const [active] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.swarmId, swarm.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .limit(1);
    if (!active) {
      const status = spawn.cap === "budget" ? ("budget_exhausted" as const) : ("paused" as const);
      const pausedReason = spawn.cap === "budget" ? ("budget" as const) : ("plan_limit" as const);
      if (swarm.status !== status || swarm.pausedReason !== pausedReason) {
        await tx
          .update(swarms)
          .set({ status, pausedReason, updatedAt: new Date() })
          .where(eq(swarms.id, swarm.id));
        events.push({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id, status });
      }
      return status;
    }
  }

  // Spawning just changed assigned leaves to working, and the landing
  // queue may have changed more rows. Read this tree now rather than
  // using rollUp's earlier snapshot: failed siblings must not make an
  // active swarm read as failed, and dependents must still hold up done.
  const roots = currentRootStatuses(tasks);
  const attention = tasks.some((task) => task.attention !== null && task.status !== "cancelled");
  const rolled = swarmStatusFrom(swarm.status, roots, swarm.pausedReason);
  // A leaf waiting on a person holds the whole swarm's headline, even
  // while its siblings keep working: a board nobody has to read for a
  // stalled node is a board nobody reads.
  const status = attention && rolled === "running" ? "blocked" : rolled;
  if (status === swarm.status) return status;

  await tx
    .update(swarms)
    // A swarm that has left a pause is not paused for anything, and a
    // reason left behind is what the board would still print.
    .set({ status, ...(swarm.status === "paused" ? { pausedReason: null } : {}), updatedAt: new Date() })
    .where(eq(swarms.id, swarm.id));
  events.push({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id, status });
  return status;
}

/**
 * Queues a tick for one swarm.
 *
 * Every door uses this rather than a bare send, for the reason
 * enqueueRun exists: the singleton key is what makes a burst of
 * finishing workers one tick rather than one tick each, and a bare
 * send would be a tick per event that each read the same rows.
 */
export async function enqueueSwarmTick(ctx: AppContext, swarmId: string): Promise<void> {
  // The worker first, then the job, and both in one turn of the
  // lifecycle lock: a deployment with no swarms runs no worker, so the
  // order is what keeps a job from waiting for the next restart to be
  // read, and the lock is what keeps a stop from landing in between.
  await inTurn(ctx.boss, async () => {
    await registerTickWorker(ctx);
    await ctx.boss.send(SWARM_TICK_QUEUE, { swarmId }, { singletonKey: swarmId });
  });
  /**
   * And the clock, from the same door.
   *
   * Outside the lifecycle turn because it is a different worker with a
   * different lifetime: the tick worker stops when nothing is running,
   * and the watchdog has to outlive exactly that, for the swarm that is
   * paused waiting on a ceiling somewhere else to lift. Its own failure
   * is never this send's: a tick that could not also start a schedule
   * is still a tick.
   */
  await ensureSwarmWatchdog(ctx).catch((err: unknown) => {
    console.warn("could not start the swarm watchdog:", err);
    ctx.analytics?.captureException(err, null, null, { queue: SWARM_TICK_QUEUE });
  });
}

/**
 * Starts the swarm reconciler's worker, if this process has not.
 *
 * The worker polls at the interactive pace, for the same reason the
 * gate's does: a person is watching a board that moves when it runs.
 * That pace is only cheap while it is earning its keep, and most
 * deployments have never started a swarm, so the worker is started by
 * the first tick rather than at boot and stopped again when the last
 * swarm settles. Single job at a time, because two ticks for one swarm
 * serializing on its row lock is work done twice.
 *
 * Idempotent, and safe to call concurrently: the boss is marked before
 * the await, so a second caller does not register a second worker.
 */
export async function ensureSwarmTickWorker(ctx: AppContext): Promise<void> {
  await inTurn(ctx.boss, () => registerTickWorker(ctx));
}

/** The registration itself. Only ever called inside a lifecycle turn. */
async function registerTickWorker(ctx: AppContext): Promise<void> {
  if (tickWorkers.has(ctx.boss)) return;
  tickWorkers.add(ctx.boss);
  try {
    await ctx.boss.work<{ swarmId: string }>(
      SWARM_TICK_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: INTERACTIVE_POLL_SECONDS },
      captureJobErrors(ctx.analytics, SWARM_TICK_QUEUE, async (jobs) => {
        for (const job of jobs) await tickSwarm(ctx, job.data.swarmId);
        // After the tick, because the tick is what settles the last
        // swarm. offWork only flags the worker, so a stop from inside
        // its own handler does not wait on this job.
        await stopSwarmTickWorkerIfIdle(ctx);
      }),
    );
  } catch (err) {
    tickWorkers.delete(ctx.boss);
    throw err;
  }
}

/**
 * Stops the worker when this deployment has nothing left to reconcile.
 *
 * The question is asked inside the lifecycle turn that would do the
 * stopping, rather than before it, so a tick enqueued for a live swarm
 * cannot be sent into a queue this is already leaving: whichever of
 * the two takes the lock first, the other reads the world it left. A
 * send that got in first leaves an active swarm for this to find, and
 * one that comes after finds no worker registered and registers again.
 */
export async function stopSwarmTickWorkerIfIdle(ctx: AppContext): Promise<boolean> {
  const stopped = await inTurn(ctx.boss, async () => {
    if (!tickWorkers.has(ctx.boss)) return false;
    if (await hasActiveSwarms(ctx)) return false;
    tickWorkers.delete(ctx.boss);
    await ctx.boss.offWork(SWARM_TICK_QUEUE);
    return true;
  });
  /**
   * The clock goes when there is nothing left for it to watch, which
   * is a later moment than this one.
   *
   * A swarm paused on a plan limit keeps the watchdog even though it
   * keeps no tick worker: it has nothing in flight to reconcile, and
   * it is the one state that cannot wake itself, so something has to
   * keep asking whether the ceiling has lifted.
   */
  if (!(await hasWatchedSwarms(ctx))) {
    await stopSwarmWatchdog(ctx).catch((err: unknown) => {
      console.warn("could not stop the swarm watchdog:", err);
    });
  }
  return stopped;
}

/** Stops the tick worker, so an idle deployment stops paying for the poll. */
export async function stopSwarmTickWorker(ctx: AppContext): Promise<void> {
  await inTurn(ctx.boss, async () => {
    if (!tickWorkers.has(ctx.boss)) return;
    tickWorkers.delete(ctx.boss);
    await ctx.boss.offWork(SWARM_TICK_QUEUE);
  });
}

/**
 * Every swarm that has not finished gets one tick at boot.
 *
 * A swarm's state lives in its rows, so a restart loses nothing except
 * the jobs that were in flight; this is what puts those back. Runs the
 * previous process was carrying are recovered separately, before this,
 * so the tick reads a tree whose runs have already been closed or
 * reattached.
 */
export async function tickAllLiveSwarms(ctx: AppContext): Promise<number> {
  /*
   * The watchdog's question rather than the tick worker's, and the
   * difference is one swarm that would otherwise never move again.
   *
   * A swarm paused on a plan limit has nothing in flight, so it is not
   * "active" in the sense the tick worker means. It is also the only
   * state that cannot wake itself: its hours come back when a period
   * rolls over or somebody allows overage, and neither is an event
   * this server hears about. The watchdog is what asks on its behalf,
   * and the watchdog is started from this door. Booting with only the
   * active statuses registered nothing, so a deploy in the half hour
   * after a team ran out of hours stranded the swarm for good.
   */
  const live = await ctx.db.select({ id: swarms.id }).from(swarms).where(WATCHED_SWARMS);
  for (const row of live) await enqueueSwarmTick(ctx, row.id);
  return live.length;
}
