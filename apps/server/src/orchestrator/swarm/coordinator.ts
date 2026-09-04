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
import { ACTIVE_RUN_STATUSES, startRunIfIdle, type NewRun, type OutOfCompute } from "../start-run.js";
import { plannerWakeMessage, type PlannerWakeItem } from "./planner-prompt.js";

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
  startRun(tx: Tx, values: NewRun): Promise<typeof agentRuns.$inferSelect | "busy" | "gone" | OutOfCompute>;
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
  /** Why the spawn loop stopped early, when a plan limit stopped it. */
  spawnRefusal: string | null;
  /** The landing promoted to the front of the queue, if any. */
  landingId: string | null;
  /** The swarm's status after the tick. */
  status: (typeof swarms.$inferSelect)["status"];
}

/**
 * Reconciles one swarm.
 *
 * The board events are emitted after the transaction commits, never
 * inside it: a viewer that refetches on an event has to find the state
 * the event describes, and a client that refetched inside the
 * transaction would read the rows as they were before it.
 */
export async function tickSwarm(
  ctx: AppContext,
  swarmId: string,
  deps: SwarmTickDeps = { startRun: (tx, values) => startRunIfIdle(tx as unknown as Db, values, ctx.entitlements, ctx.analytics) },
): Promise<SwarmTickResult | null> {
  const events: BoardEvent[] = [];
  const result = await ctx.db.transaction(async (tx) => runTick(tx, swarmId, deps, events));
  for (const event of events) ctx.bus.emitBoardEvent(event);
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

  const changed = await rollUp(tx, swarm, tasks, events);
  const plannerRunId = await deliverPlannerWake(tx, swarm, deps, now);
  const spawned = await spawnWorkers(tx, swarm, changed.tasks, deps, events, now);
  const landingId = await advanceLandingQueue(tx, swarm, changed.tasks, deps, now);
  const status = await recomputeSwarmStatus(tx, swarm, changed.tasks, events);

  return {
    changedTasks: changed.changedCount,
    plannerRunId,
    workerRunIds: spawned.runIds,
    spawnRefusal: spawned.refusal,
    landingId,
    status,
  };
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

const ZERO: Cost = { measured: 0, estimated: 0, assumed: 0 };

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
    let cost = ZERO;
    for (const child of children) cost = addCost(cost, visit(child));
    // A group's own measured cost is its children's: nothing runs on
    // the group itself, so anything recorded there is a rollup too.
    next.set(task.id, { status: rollUpStatus(task.status, children.map((c) => next.get(c.id)!.status)), cost });
    return cost;
  };

  let total = ZERO;
  for (const root of byParent.get(null) ?? []) total = addCost(total, visit(root));

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

  const spendChanged =
    total.measured !== Number(swarm.spentMeasuredUsd)
    || total.estimated !== Number(swarm.spentEstimatedUsd)
    || total.assumed !== Number(swarm.spentAssumedUsd);
  if (spendChanged) {
    await tx
      .update(swarms)
      .set({
        spentMeasuredUsd: String(total.measured),
        spentEstimatedUsd: String(total.estimated),
        spentAssumedUsd: String(total.assumed),
        updatedAt: new Date(),
      })
      .where(eq(swarms.id, swarm.id));
    swarm.spentMeasuredUsd = String(total.measured);
    swarm.spentEstimatedUsd = String(total.estimated);
    swarm.spentAssumedUsd = String(total.assumed);
  }

  return { tasks: updated, changedCount };
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

  // What the tree did while the planner was away: reports and endings
  // it has not been told about. Reported and failed leaves only; a
  // status the planner itself set is not news to it.
  const reported = await tx
    .select()
    .from(swarmTasks)
    .where(
      and(
        eq(swarmTasks.swarmId, swarm.id),
        inArray(swarmTasks.status, ["done", "failed"]),
        sql`coalesce((${swarmTasks.flags} ->> 'plannerToldAt'), '') = ''`,
      ),
    )
    .orderBy(asc(swarmTasks.position));

  if (pending.length === 0 && reported.length === 0) return null;

  const profileId = await plannerProfileFor(tx, swarm);
  // Nothing to run the planner as. The messages stay queued, so this
  // resolves itself the moment a planner agent is set on the template.
  if (!profileId) return null;

  const items: PlannerWakeItem[] = [
    ...reported.map((task) => ({
      kind: "task" as const,
      taskId: task.id,
      title: task.title,
      status: task.status,
      report: task.report,
    })),
    ...pending.map((message) => ({ kind: "message" as const, text: message.text })),
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
  if (started === "busy" || started === "gone" || "outOfCompute" in started) return null;

  for (const message of pending) {
    await tx
      .update(swarmMessages)
      .set({ status: "sent", runId: started.id, sentAt: now })
      .where(eq(swarmMessages.id, message.id));
  }
  for (const task of reported) {
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
   */
  if (swarm.status !== "running" && swarm.status !== "blocked") return { runIds, refusal: null };

  const ready = tasks.filter((task) => task.kind === "leaf" && task.status === "assigned");
  if (ready.length === 0) return { runIds, refusal: null };

  const profileId = await workerProfileFor(tx, swarm);
  if (!profileId) return { runIds, refusal: null };

  for (const task of ready) {
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
    // Full, or something already on this leaf. Either way there is no
    // room for the leaves behind it either.
    if (started === "busy" || started === "gone") break;
    if ("outOfCompute" in started) {
      await tx
        .update(swarmTasks)
        .set({
          attention: "budget",
          flags: { ...task.flags, spawnRefusal: started.outOfCompute },
          updatedAt: now,
        })
        .where(eq(swarmTasks.id, task.id));
      await tx.insert(swarmTaskEvents).values({
        taskId: task.id,
        kind: "attention_raised",
        detail: { reason: started.outOfCompute },
      });
      // The in-memory row too, so step five sees the attention this
      // step just raised rather than the tree as it was before it.
      task.attention = "budget";
      events.push({
        type: "swarm_task_updated",
        projectId: swarm.projectId,
        swarmId: swarm.id,
        taskId: task.id,
        status: task.status,
      });
      return { runIds, refusal: started.outOfCompute };
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

/**
 * Keeps the merge queue honest, and hands its front row to whatever
 * lands branches.
 *
 * One landing at a time is a database fact (the partial unique index on
 * swarm_landings), not a property of this function, so all this does is
 * decide which row is next and drop the ones whose work went away.
 */
async function advanceLandingQueue(
  tx: Tx,
  swarm: typeof swarms.$inferSelect,
  tasks: Task[],
  deps: SwarmTickDeps,
  now: Date,
): Promise<string | null> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const queue = await tx
    .select()
    .from(swarmLandings)
    .where(eq(swarmLandings.swarmId, swarm.id))
    .orderBy(asc(swarmLandings.position), asc(swarmLandings.createdAt));

  // A landing for work somebody withdrew has nothing left to land.
  for (const landing of queue) {
    if (landing.status !== "queued") continue;
    const task = byId.get(landing.taskId);
    if (task && task.status !== "cancelled") continue;
    await tx
      .update(swarmLandings)
      .set({ status: "cancelled", endedAt: now, updatedAt: now })
      .where(eq(swarmLandings.id, landing.id));
  }

  const inFlight = queue.find((landing) => landing.status === "landing");
  if (inFlight) return inFlight.id;
  // A conflict is a person's or a resolver's problem, and either way it
  // holds the queue: landing the row behind it would put the conflicted
  // branch permanently out of order.
  if (queue.some((landing) => landing.status === "conflicted")) return null;

  const next = queue.find(
    (landing) => landing.status === "queued" && byId.get(landing.taskId)?.status !== "cancelled",
  );
  // Nothing performs landings in this deployment yet. Promoting the row
  // would move it into a state nothing takes it out of, so the queue is
  // left as it is and the row keeps its place.
  if (!next || !deps.startLanding) return null;

  await tx
    .update(swarmLandings)
    .set({ status: "landing", startedAt: now, attempt: next.attempt + 1, updatedAt: now })
    .where(eq(swarmLandings.id, next.id));
  await deps.startLanding(tx, next.id);
  return next.id;
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
): Promise<(typeof swarms.$inferSelect)["status"]> {
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
export async function enqueueSwarmTick(
  ctx: Pick<AppContext, "boss">,
  swarmId: string,
): Promise<void> {
  await ctx.boss.send(SWARM_TICK_QUEUE, { swarmId }, { singletonKey: swarmId });
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
    .where(inArray(swarms.status, ["planning", "running", "blocked", "paused"]));
  for (const row of live) await enqueueSwarmTick(ctx, row.id);
  return live.length;
}
