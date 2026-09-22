import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentRuns,
  swarmLandings,
  swarmMessages,
  swarmTaskEvents,
  swarmTasks,
  swarmTemplates,
  swarms,
  type Db,
} from "@bento/db";
import type { AppContext } from "../../context.js";
import type { BoardEvent } from "../../events.js";
import { captureJobErrors } from "../../analytics.js";
import { enqueueRun, INTERACTIVE_POLL_SECONDS } from "../queue.js";
import { queueSwarmSandboxReap } from "../reap-sandbox.js";
import { ACTIVE_RUN_STATUSES, SWARM_FULL, startRunIfIdle, type NewRun, type OutOfCompute } from "../start-run.js";
import { plannerWakeMessage, type PlannerWakeItem } from "./planner-prompt.js";
import { enqueueLanding } from "./landing.js";
import { enqueueSwarmPublish } from "./complete.js";
import { handLeafToPlanner, PLANNER_NOT_TOLD } from "./planner-news.js";
import { assumedCostFor, budgetIsLow, enforcedSpend, money, spendOf } from "./ledger.js";

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

/** And the states a swarm never comes back from, which end its machine. */
function swarmIsOver(status: (typeof swarms.$inferSelect)["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
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
}

/** What one tick did, for the log and for the tests. */
export interface SwarmTickResult {
  /** Tasks whose status this tick changed. */
  changedTasks: number;
  /** The planner run this tick started, if it started one. */
  plannerRunId: string | null;
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
    /**
     * A swarm that just finished has one thing left to do, and it is
     * the only thing in a swarm that leaves Bento: push the branch and
     * open the pull requests.
     *
     * On its own queue rather than inline, because it clones, pushes
     * and talks to GitHub, and the tick worker runs one job at a time
     * for every swarm on the deployment. After the commit, because the
     * job reads the swarm's status and refuses anything but "done".
     */
    if (result.becameDone) await enqueueSwarmPublish(ctx, swarmId);
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
     */
    if (swarmIsOver(result.status)) await queueSwarmSandboxReap(ctx, swarmId);
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
  const changed = await rollUp(tx, swarm, tasks, events);
  await warnLowBudget(tx, swarm, now);
  const plannerRunId = await deliverPlannerWake(tx, swarm, deps, now);
  const spawned = await spawnWorkers(tx, swarm, changed.tasks, deps, events, now);
  const landing = await advanceLandingQueue(tx, swarm, changed.tasks, deps, events, now);
  const status = await recomputeSwarmStatus(tx, swarm, changed.tasks, events, spawned);

  return {
    changedTasks: changed.changedCount,
    plannerRunId,
    workerRunIds: spawned.runIds,
    resolverRunIds: landing.resolverRunIds,
    spawnRefusal: spawned.refusal,
    landingId: landing.landing?.id ?? null,
    landingPromoted: landing.landing?.promoted ?? false,
    status,
    becameDone: status === "done" && swarm.status !== "done",
  };
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
 * So a leaf whose run is gone and whose report never arrived is failed,
 * with the reason on the row. Failing it is what puts it in front of
 * the planner, which can reject it back to assigned, split it, or give
 * up on it. Silence cannot be any of those.
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
  const working = tasks.filter(
    (task) => task.nodeType === "leaf" && task.status === "working" && !task.report && task.assignedRunId,
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
    const reason = run?.error?.trim()
      ? `the agent working it stopped: ${run.error.trim()}`
      : "the agent working it stopped without reporting.";
    // Through the one door, so the latch that decides whether the
    // planner ever hears about this leaf is cleared by construction.
    await handLeafToPlanner(tx, {
      task,
      status: "failed",
      attention: "failed",
      flags: { workerStopped: reason },
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
  let changedCount = 0;

  /** Depth first, so a node is decided only after its children are. */
  const visit = (task: Task): Cost => {
    const children = byParent.get(task.id) ?? [];
    if (children.length === 0) {
      const cost = leafCost(task);
      next.set(task.id, { status: task.status, cost });
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
    next.set(task.id, {
      status: rollUpStatus(task.status, children.map((c) => next.get(c.id)!.status)),
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
  const perRun = await assumedCostFor(tx as unknown as Db, swarm);
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
 * Everything waiting for the planner becomes one message and one run.
 *
 * Held while a planner run is active, for two reasons. A headless CLI
 * cannot hear mid turn, so a second wake would be a second run on a
 * tree the first one is still editing; and the folding is the point,
 * because five workers finishing within a minute of each other is one
 * thing the planner needs to know, not five wake ups it pays for
 * separately. The run's settlement enqueues a tick, and this delivers
 * then.
 */
async function deliverPlannerWake(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  deps: SwarmTickDeps,
  now: Date,
): Promise<string | null> {
  if (swarm.status === "paused" || swarm.status === "cancelled" || swarm.status === "draft") return null;

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
  if (activePlanner) return null;

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

  if (pending.length === 0 && news.length === 0) return null;

  const profileId = await plannerProfileFor(tx, swarm);
  // Nothing to run the planner as. The messages stay queued, so this
  // resolves itself the moment a planner agent is set on the template.
  if (!profileId) return null;

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
  ];

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
  if (started === "busy" || started === "gone" || started === SWARM_FULL || "outOfCompute" in started) {
    return null;
  }

  for (const message of pending) {
    await tx
      .update(swarmMessages)
      .set({ status: "sent", runId: started.id, sentAt: now })
      .where(eq(swarmMessages.id, message.id));
  }
  for (const task of news) {
    await tx
      .update(swarmTasks)
      .set({ flags: { ...task.flags, plannerToldAt: now.toISOString() } })
      .where(eq(swarmTasks.id, task.id));
  }
  return started.id;
}

/** The agent the planner runs as, which a swarm gets from its template. */
async function plannerProfileFor(tx: Tx, swarm: typeof swarms.$inferSelect): Promise<string | null> {
  if (!swarm.templateId) return null;
  const [template] = await tx
    .select({ plannerProfileId: swarmTemplates.plannerProfileId })
    .from(swarmTemplates)
    .where(eq(swarmTemplates.id, swarm.templateId))
    .limit(1);
  return template?.plannerProfileId ?? null;
}

async function workerProfileFor(tx: Tx, swarm: typeof swarms.$inferSelect): Promise<string | null> {
  if (!swarm.templateId) return null;
  const [template] = await tx
    .select({ workerProfileId: swarmTemplates.workerProfileId })
    .from(swarmTemplates)
    .where(eq(swarmTemplates.id, swarm.templateId))
    .limit(1);
  return template?.workerProfileId ?? null;
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
  if (swarm.status === "budget_exhausted") return true;
  return swarm.status === "paused" && swarm.pausedReason === "plan_limit";
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

  const ready = tasks.filter((task) => task.nodeType === "leaf" && task.status === "assigned");
  if (ready.length === 0) return { runIds, refusal: null, cap: null };

  const templateWorker = await workerProfileFor(tx, swarm);

  for (const task of ready) {
    /*
     * The agent a person chose for this leaf, or the template's.
     *
     * Reassigning a leaf that a cheap worker could not finish writes
     * the choice on the node, so it survives a retry and does not
     * change the agent every other leaf gets.
     */
    const profileId = task.agentProfileId ?? templateWorker;
    // Nothing to run it as. The leaf keeps its place in the queue, and
    // starts the moment a worker agent is set on the template.
    if (!profileId) break;
    const started = await deps.startRun(tx, {
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: task.id,
      role: "worker",
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
         */
        ...(task.attention === "budget" || task.attention === "plan_limit" ? { attention: null } : {}),
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
  if (runIds.length > 0 && swarm.status !== "running" && swarm.status !== "blocked") {
    await tx
      .update(swarms)
      .set({ status: "running", pausedReason: null, updatedAt: now })
      .where(eq(swarms.id, swarm.id));
    swarm.status = "running";
    swarm.pausedReason = null;
    events.push({ type: "swarm_updated", projectId: swarm.projectId, swarmId: swarm.id, status: "running" });
  }
  return { runIds, refusal: null, cap: null };
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
): Promise<LandingStep> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const resolverRunIds: string[] = [];
  const queue = await tx
    .select()
    .from(swarmLandings)
    .where(eq(swarmLandings.swarmId, swarm.id))
    .orderBy(asc(swarmLandings.position), asc(swarmLandings.createdAt));

  /**
   * A landing for work somebody withdrew has nothing left to land.
   *
   * Conflicted as well as queued, because a conflicted row holds the
   * queue: a leaf cancelled while its branch was in conflict would
   * otherwise stop every landing behind it with nothing left that could
   * ever settle it.
   */
  for (const landing of queue) {
    if (landing.status !== "queued" && landing.status !== "conflicted") continue;
    const task = byId.get(landing.taskId);
    if (task && task.status !== "cancelled") continue;
    await tx
      .update(swarmLandings)
      .set({ status: "cancelled", endedAt: now, updatedAt: now })
      .where(eq(swarmLandings.id, landing.id));
    landing.status = "cancelled";
  }

  const inFlight = queue.find((landing) => landing.status === "landing");
  if (inFlight) return { landing: { id: inFlight.id, promoted: false }, resolverRunIds };

  const conflicts = queue.filter((landing) => landing.status === "conflicted");
  for (const landing of conflicts) {
    /**
     * A conflict with nobody on it. Either an agent can be started on
     * it now, or this is a conflict nothing will ever resolve and the
     * leaf fails; the one thing that must not happen is the row being
     * left exactly as it is, because nothing else in the swarm moves it
     * and everything behind it waits on it.
     */
    if (!landing.resolverRunId) {
      const runId = await startResolver(tx, swarm, landing, byId.get(landing.taskId), deps, events, now);
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

  const next = queue.find(
    (landing) => landing.status === "queued" && byId.get(landing.taskId)?.status !== "cancelled",
  );
  // Nothing performs landings in this deployment yet. Promoting the row
  // would move it into a state nothing takes it out of, so the queue is
  // left as it is and the row keeps its place.
  if (!next || !deps.startLanding) return { landing: null, resolverRunIds };

  await tx
    .update(swarmLandings)
    .set({ status: "landing", startedAt: now, attempt: next.attempt + 1, updatedAt: now })
    .where(eq(swarmLandings.id, next.id));
  await deps.startLanding(tx, next.id);
  return { landing: { id: next.id, promoted: true }, resolverRunIds };
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
 * for. No worker agent on the template is permanent, so the leaf fails
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
): Promise<string | null> {
  // A row whose leaf is gone is the cancel sweep's, not this one's.
  if (!task || task.status === "cancelled") return null;

  const profileId = await workerProfileFor(tx, swarm);
  if (!profileId) {
    const reason =
      "this swarm's template has no worker agent, so nothing can be put on the conflict. Set one on the template, and the planner can hand this work out again.";
    await tx
      .update(swarmLandings)
      .set({
        status: "failed",
        error: [landing.error, "", reason].filter((line) => line !== null).join("\n"),
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(swarmLandings.id, landing.id));
    await handLeafToPlanner(tx, {
      task,
      status: "failed",
      attention: "conflict",
      flags: { landingError: reason },
      detail: { landingError: reason },
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
  if (started === "busy" || started === "gone" || started === SWARM_FULL || "outOfCompute" in started) {
    return null;
  }

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
): (typeof swarms.$inferSelect)["status"] {
  if (current === "draft" || current === "planning" || current === "paused" || current === "cancelled") {
    return current;
  }
  /*
   * And the two ceilings, for the same reason: a swarm stopped by its
   * budget or its clock has a tree full of open leaves, which reads as
   * a swarm at work. Only a spawn that succeeds takes it out of these,
   * and the spawn step is what writes that.
   */
  if (current === "budget_exhausted" || current === "timed_out") return current;
  // Started, with nothing in the plan to summarize.
  if (roots.length === 0) return current;
  const rolled = rollUpStatus("open", roots);
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

  const roots = tasks.filter((task) => task.parentId === null).map((task) => task.status);
  const attention = tasks.some((task) => task.attention !== null && task.status !== "cancelled");
  const rolled = swarmStatusFrom(swarm.status, roots);
  // A leaf waiting on a person holds the whole swarm's headline, even
  // while its siblings keep working: a board nobody has to read for a
  // stalled node is a board nobody reads.
  const status = attention && rolled === "running" ? "blocked" : rolled;
  if (status === swarm.status) return status;

  await tx.update(swarms).set({ status, updatedAt: new Date() }).where(eq(swarms.id, swarm.id));
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
  return await inTurn(ctx.boss, async () => {
    if (!tickWorkers.has(ctx.boss)) return false;
    if (await hasActiveSwarms(ctx)) return false;
    tickWorkers.delete(ctx.boss);
    await ctx.boss.offWork(SWARM_TICK_QUEUE);
    return true;
  });
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
  const live = await ctx.db
    .select({ id: swarms.id })
    .from(swarms)
    .where(inArray(swarms.status, [...ACTIVE_SWARM_STATUSES]));
  for (const row of live) await enqueueSwarmTick(ctx, row.id);
  return live.length;
}
