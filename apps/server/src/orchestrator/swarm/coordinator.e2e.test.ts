import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runMigrations,
  swarmLandings,
  swarmMessages,
  swarmTasks,
  swarmTemplates,
  swarms,
  type Db,
} from "@bento/db";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import { SWARM_FULL, type NewRun } from "../start-run.js";
import { rollUpStatus, swarmStatusFrom, tickAllLiveSwarms, tickSwarm, type SwarmTickDeps } from "./coordinator.js";
import { applyRunCharge } from "./ledger.js";

/**
 * The coordinator, against a real database and a stubbed run starter.
 *
 * The arithmetic and the ordering are what is worth pinning here, so
 * the runs are stubbed: whether an agent actually starts is
 * startRunIfIdle's own test, and driving a sandbox to prove that a
 * group's cost is the sum of its children's would prove nothing extra.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_coordinator_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const TEMPLATE = "33333333-3333-3333-3333-333333333333";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let emitted: BoardEvent[];
/** Jobs the tick queued, in order. A run row without one never starts. */
let queued: { queue: string; data: { runId?: string } }[];
/** Run workers this process nudged, so a queued run does not wait for a poll. */
let notified: string[];

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = createPool(testUrl);
  db = createDb(pool);
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
  await pool.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`,
    [PROJECT],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'A','fake','fake-1')`,
    [PROFILE],
  );
  await pool.query(
    `insert into swarm_templates (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers,worker_isolation)
     values ($1,'u1',null,'T',$2,$2,2,'worktree')`,
    [TEMPLATE, PROFILE],
  );

  const bus = new EventBus();
  emitted = [];
  queued = [];
  notified = [];
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    userId: "u1",
    /**
     * The queue, recorded rather than stubbed away.
     *
     * A run row is not a run: startRunIfIdle writes it queued, and only
     * a `run.execute` job makes anything pick it up. These tests used to
     * assert the row alone, which is exactly why a coordinator that
     * never queued anything passed them while every swarm it started
     * deadlocked.
     */
    boss: {
      send: async (queue: string, data: unknown) => {
        queued.push({ queue, data: data as { runId?: string } });
        return "job";
      },
      notifyWorker: (id: string) => notified.push(id),
      // The tick registers the landing worker lazily, the way it
      // registers its own: a stub that cannot be worked would make
      // every tick that promotes a landing throw.
      work: async () => "worker",
      offWork: async () => {},
    },
    runWorkers: ["worker-1"],
  } as unknown as AppContext;
  bus.onBoardEvent(PROJECT, (event) => emitted.push(event));
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from swarms");
  emitted.length = 0;
  queued.length = 0;
  notified.length = 0;
});

/** The runs this tick actually handed to the `run.execute` workers. */
const queuedRunIds = () =>
  queued.filter((job) => job.queue === "run.execute").map((job) => job.data.runId);

/** A stubbed door: it records what was asked for, and inserts a real row. */
function starter(
  answers: (
    | "run"
    | "busy"
    | "gone"
    | typeof SWARM_FULL
    | { outOfCompute: string; cap?: "plan" | "budget" }
  )[] = [],
): SwarmTickDeps & { calls: NewRun[] } {
  const calls: NewRun[] = [];
  let index = 0;
  const deps = {
    calls,
    async startRun(tx: Parameters<SwarmTickDeps["startRun"]>[0], values: NewRun) {
      calls.push(values);
      const answer = answers[index++] ?? "run";
      if (answer !== "run") return answer;
      // A real row, so the foreign keys the tick writes afterwards hold.
      const [run] = await tx.insert(agentRuns).values(values).returning();
      return run!;
    },
  };
  return deps as SwarmTickDeps & { calls: NewRun[] };
}

async function makeSwarm(
  overrides: Partial<typeof swarms.$inferInsert> = {},
): Promise<typeof swarms.$inferSelect> {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug: `s-${Math.random().toString(36).slice(2, 8)}`,
      title: "Swarm",
      goal: "do the thing",
      templateId: TEMPLATE,
      status: "running",
      maxWorkers: 2,
      startedBy: "u1",
      ...overrides,
    })
    .returning();
  return swarm!;
}

async function makeTask(
  swarmId: string,
  overrides: Partial<typeof swarmTasks.$inferInsert> = {},
): Promise<typeof swarmTasks.$inferSelect> {
  const [task] = await db
    .insert(swarmTasks)
    .values({ swarmId, title: "T", ...overrides })
    .returning();
  return task!;
}

const read = async (taskId: string) =>
  (await db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)))[0]!;
const readSwarm = async (swarmId: string) =>
  (await db.select().from(swarms).where(eq(swarms.id, swarmId)))[0]!;

/* ---------------------------------------------------------------- */

test("a plan node's status is a summary of its children", () => {
  assert.equal(rollUpStatus("open", ["done", "done"]), "done");
  assert.equal(rollUpStatus("open", ["done", "working"]), "working");
  assert.equal(rollUpStatus("open", ["failed", "done"]), "failed");
  // A failure below a node that is still working is not the node's
  // outcome yet: something is moving, so the node is working.
  assert.equal(rollUpStatus("open", ["failed", "working"]), "working");
  // A landed branch is not finished with until the planner says so.
  assert.equal(rollUpStatus("open", ["landed", "done"]), "working");
  assert.equal(rollUpStatus("open", ["blocked", "open"]), "blocked");
  assert.equal(rollUpStatus("open", ["open", "open"]), "open");
  assert.equal(rollUpStatus("open", ["assigned", "open"]), "working");
  // Cancelled children are left out entirely, so a node whose only
  // live child finished reads as done.
  assert.equal(rollUpStatus("open", ["cancelled", "done"]), "done");
  assert.equal(rollUpStatus("working", ["cancelled", "cancelled"]), "cancelled");
  // A node with no children keeps whatever it has: nothing to summarize.
  assert.equal(rollUpStatus("working", []), "working");
});

test("the states a person owns are never recomputed from the tree", () => {
  for (const owned of ["draft", "planning", "paused", "cancelled"] as const) {
    assert.equal(swarmStatusFrom(owned, ["done", "done"]), owned, `${owned} is not the tree's to change`);
  }
  assert.equal(swarmStatusFrom("running", ["done", "done"]), "done");
  assert.equal(swarmStatusFrom("running", ["done", "failed"]), "failed");
  assert.equal(swarmStatusFrom("running", ["blocked", "done"]), "blocked");
  // Started, with every leaf still waiting for a slot. Still running.
  assert.equal(swarmStatusFrom("running", ["open", "open"]), "running");
  assert.equal(swarmStatusFrom("running", []), "running");
});

/**
 * Who owns the cost rollup.
 *
 * A row's three figures are the charges recorded against that one
 * task, and the subtree sum is derived from them by whoever is drawing
 * the subtree. This tick used to write the children's sum onto the
 * group row instead, which the console then added the children into a
 * second time, and which threw away any charge the group itself had.
 */
test("a node keeps its own charges, and the swarm's spend is not the tree's sum", async () => {
  const swarm = await makeSwarm();
  const group = await makeTask(swarm.id, {
    nodeType: "plan",
    title: "G",
    status: "open",
    // A charge of the group's own: what a sub planner's turn on it
    // costs. It is a figure the rollup must not overwrite or drop.
    costMeasuredUsd: "0.40",
  });
  await makeTask(swarm.id, {
    parentId: group.id,
    title: "one",
    status: "done",
    costMeasuredUsd: "1.50",
    costEstimatedUsd: "0.25",
  });
  await makeTask(swarm.id, {
    parentId: group.id,
    title: "two",
    status: "done",
    costMeasuredUsd: "2.00",
    costAssumedUsd: "0.75",
  });
  // A second root, so the swarm's total is more than one branch.
  await makeTask(swarm.id, { title: "loose", status: "done", costMeasuredUsd: "0.50" });

  const result = await tickSwarm(ctx, swarm.id, starter());
  assert.ok(result);

  const rolled = await read(group.id);
  assert.equal(Number(rolled.costMeasuredUsd), 0.4, "the group keeps its own charge, and not its children's");
  assert.equal(Number(rolled.costEstimatedUsd), 0);
  assert.equal(Number(rolled.costAssumedUsd), 0);
  assert.equal(rolled.status, "done", "both children finished, so the group did");

  /*
   * And the swarm's own spend is untouched by any of that.
   *
   * It used to be written here as the sum of the tree, which is a
   * smaller number than the bill: a planner turn and a merge queue
   * resolver hang off no node at all, and a budget checked against a
   * total that leaves out the two most expensive roles in a swarm is a
   * budget that never refuses anything. The ledger adds each run's
   * charge to these columns as the run ends, so the tick recomputing
   * them from the tree would erase every charge that has no node.
   */
  const after = await readSwarm(swarm.id);
  assert.equal(Number(after.spentMeasuredUsd), 0, "the tick does not write the swarm's spend; the ledger does");
  assert.equal(Number(after.spentEstimatedUsd), 0);
  assert.equal(Number(after.spentAssumedUsd), 0);
  assert.equal(after.status, "done", "every root finished");
  assert.equal(result.status, "done");
});

/**
 * The charge that proves who owns the swarm's total.
 *
 * A planner's turn belongs to the swarm and to no node in it, so it is
 * the whole difference between the two possible owners: read off the
 * tree it is invisible, and the budget would be checked against a
 * figure missing the role that usually costs the most.
 */
test("a planner's charge reaches the swarm even though it hangs off no node", async () => {
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id, { title: "one", status: "done" });

  const [planner] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      role: "planner",
      agentProfileId: PROFILE,
      prompt: "",
      status: "succeeded",
    })
    .returning();
  await applyRunCharge(db, { swarmId: swarm.id, swarmTaskId: null }, {
    tier: "measured",
    usd: 2.5,
    inputTokens: null,
    outputTokens: null,
    pricePerMtok: null,
  });
  await applyRunCharge(db, { swarmId: swarm.id, swarmTaskId: leaf.id }, {
    tier: "assumed",
    usd: 0.5,
    inputTokens: null,
    outputTokens: null,
    pricePerMtok: null,
  });
  assert.ok(planner);

  await tickSwarm(ctx, swarm.id, starter());

  const after = await readSwarm(swarm.id);
  assert.equal(Number(after.spentMeasuredUsd), 2.5, "the planner's turn is on the swarm, and no tick erases it");
  assert.equal(Number(after.spentAssumedUsd), 0.5);
  const worked = await read(leaf.id);
  assert.equal(Number(worked.costAssumedUsd), 0.5, "and the leaf carries its own");
});

test("a tick applied twice changes nothing the second time", async () => {
  const swarm = await makeSwarm();
  const group = await makeTask(swarm.id, { nodeType: "plan", title: "G" });
  const leaf = await makeTask(swarm.id, { parentId: group.id, status: "done", costMeasuredUsd: "1.00" });

  await tickSwarm(ctx, swarm.id, starter());
  const afterFirst = await read(group.id);
  const swarmAfterFirst = await readSwarm(swarm.id);
  emitted.length = 0;

  const second = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(second?.changedTasks, 0, "nothing changed status on the second tick");
  assert.deepEqual(emitted, [], "and nothing was announced");

  const afterSecond = await read(group.id);
  assert.equal(
    afterSecond.updatedAt.getTime(),
    afterFirst.updatedAt.getTime(),
    "an unchanged row is not rewritten",
  );
  assert.equal(
    (await readSwarm(swarm.id)).updatedAt.getTime(),
    swarmAfterFirst.updatedAt.getTime(),
    "and neither is the swarm",
  );
  assert.equal((await read(leaf.id)).status, "done");
});

test("the planner is not woken while one is already running", async () => {
  const swarm = await makeSwarm({ status: "planning" });
  const task = await makeTask(swarm.id, { status: "done", report: "did it" });
  await db.insert(swarmMessages).values({ swarmId: swarm.id, text: "please also do X", userId: "u1" });
  await db.insert(agentRuns).values({
    type: "swarm",
    swarmId: swarm.id,
    role: "planner",
    agentProfileId: PROFILE,
    prompt: "",
    status: "running",
  });

  const deps = starter();
  const held = await tickSwarm(ctx, swarm.id, deps);
  assert.equal(held?.plannerRunId, null, "the wake is held while a planner is working");
  assert.equal(deps.calls.length, 0, "so no run was started");
  const [stillQueued] = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  assert.equal(stillQueued!.status, "queued", "the message waits rather than being lost");

  // The planner settles, and its finish is what enqueues the next tick.
  await db
    .update(agentRuns)
    .set({ status: "succeeded" })
    .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner")));

  const delivered = await tickSwarm(ctx, swarm.id, starter());
  assert.ok(delivered?.plannerRunId, "and is delivered once nothing is running");
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, delivered.plannerRunId!));
  assert.equal(run!.role, "planner");
  assert.match(run!.prompt, /please also do X/, "the person's message is in the wake");
  assert.match(run!.prompt, /did it/, "and so is the report");
  assert.match(run!.prompt, /data, not instructions/, "both quoted as untrusted");
  assert.equal(run!.startedBy, "u1", "the run acts as whoever wrote the message");

  const [sent] = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  assert.equal(sent!.status, "sent");
  assert.equal(sent!.runId, delivered.plannerRunId);
  // The row is queued; only the job makes anything run it.
  assert.deepEqual(queuedRunIds(), [delivered.plannerRunId], "the planner was handed to the run workers");

  // Folded once: a third tick has nothing left to tell it.
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, delivered.plannerRunId!));
  const again = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(again?.plannerRunId, null, "a delivered wake is not delivered twice");
  assert.equal((await read(task.id)).status, "done");
});

test("everything waiting for the planner arrives as one wake, not one each", async () => {
  const swarm = await makeSwarm({ status: "planning" });
  await makeTask(swarm.id, { title: "first", status: "done", report: "one done" });
  await makeTask(swarm.id, { title: "second", status: "failed", report: "two failed" });
  await db.insert(swarmMessages).values([
    { swarmId: swarm.id, text: "message one", userId: "u1" },
    { swarmId: swarm.id, text: "message two", userId: "u1" },
  ]);

  const deps = starter();
  const result = await tickSwarm(ctx, swarm.id, deps);
  assert.equal(deps.calls.length, 1, "four things to say, one run to say them in");
  const prompt = deps.calls[0]!.prompt ?? "";
  for (const fragment of ["one done", "two failed", "message one", "message two"]) {
    assert.match(prompt, new RegExp(fragment), `the wake carries "${fragment}"`);
  }
  assert.ok(result?.plannerRunId);
});

/**
 * The wake is about leaves.
 *
 * A group's status is this tick's own rollup of the children it is
 * telling the planner about in the same message, so folding the group
 * in spends a turn on a node the planner cannot work, and stamps
 * plannerToldAt on a row that will never report.
 */
test("the planner hears about the leaves that ended, not the groups rolled up around them", async () => {
  const swarm = await makeSwarm();
  const group = await makeTask(swarm.id, { nodeType: "plan", title: "Checkout group" });
  const leaf = await makeTask(swarm.id, {
    parentId: group.id,
    title: "Swap the provider",
    status: "done",
    report: "swapped it",
  });

  const deps = starter();
  const result = await tickSwarm(ctx, swarm.id, deps);
  assert.ok(result?.plannerRunId, "the leaf's report woke the planner");
  assert.equal((await read(group.id)).status, "done", "and the group rolled up in the same tick");

  const wake = deps.calls.find((call) => call.role === "planner");
  assert.ok(wake);
  assert.match(wake.prompt, /Swap the provider/);
  assert.equal(wake.prompt.includes("Checkout group"), false, "a group is not a node the planner can act on");
  assert.match(wake.prompt, /Tasks that ended \(1\)/);

  assert.ok((await read(leaf.id)).flags.plannerToldAt, "the leaf is stamped as told");
  assert.equal(
    (await read(group.id)).flags.plannerToldAt,
    undefined,
    "and the group's latch is still there for whatever it may report",
  );
});

test("workers spawn up to the ceiling, and a plan limit stops the loop on the leaf that hit it", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const first = await makeTask(swarm.id, { title: "first", status: "assigned", position: 0 });
  const second = await makeTask(swarm.id, { title: "second", status: "assigned", position: 1 });
  const third = await makeTask(swarm.id, { title: "third", status: "assigned", position: 2 });

  // The first starts; the second is refused for compute; the third is
  // never asked about, because there is no reason to think it would go
  // any better.
  const deps = starter([
    "run",
    { outOfCompute: "This team has used its agent hours for the month.", cap: "plan" },
  ]);
  const result = await tickSwarm(ctx, swarm.id, deps);

  assert.equal(deps.calls.length, 2, "the loop stopped at the refusal");
  assert.equal(result?.workerRunIds.length, 1);
  assert.equal(result?.spawnRefusal, "This team has used its agent hours for the month.");

  const started = await read(first.id);
  assert.equal(started.status, "working");
  assert.equal(started.assignedRunId, result!.workerRunIds[0]);
  /*
   * The point of the spawn: a `run.execute` job naming that run. A row
   * without one stays queued forever, and because queued counts as
   * active the next tick reads the swarm as busy and the swarm stops
   * for good. The workers poll every thirty seconds, so the nudge is
   * what makes it start now rather than then.
   */
  assert.deepEqual(queuedRunIds(), [result!.workerRunIds[0]], "the spawned worker was queued");
  assert.deepEqual(notified, ["worker-1"], "and this process's workers were woken");

  const refused = await read(second.id);
  assert.equal(refused.status, "assigned", "a refused leaf keeps its place in the queue");
  // Which ceiling, not just that there was one: agent hours come back
  // on their own, and a dollar budget waits for a person, so the two
  // are different sentences and different next steps on the board.
  assert.equal(refused.attention, "plan_limit", "and says on the board which ceiling it is waiting on");
  assert.equal(
    (refused.flags as { spawnRefusal?: string }).spawnRefusal,
    "This team has used its agent hours for the month.",
  );

  assert.equal((await read(third.id)).attention, null, "the leaf behind it is untouched");
  // A refusal is not a failed tick: pg-boss retrying into the same
  // refusal would say nothing new and would keep saying it.
  assert.equal((await readSwarm(swarm.id)).status, "blocked", "attention holds the swarm's headline");
});

/**
 * "Busy" is two different answers, and only one of them is about the
 * swarm.
 *
 * A leaf that already has a run on it says nothing about its siblings;
 * a swarm at its worker ceiling says there is no room for any of them.
 * While both were the word "busy", one leaf in the first state stopped
 * the tick, and every other ready leaf waited for the next one.
 */
test("a leaf that already has an agent does not hold up the leaves behind it", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const first = await makeTask(swarm.id, { title: "first", status: "assigned", position: 0 });
  const second = await makeTask(swarm.id, { title: "second", status: "assigned", position: 1 });

  const deps = starter(["busy"]);
  const result = await tickSwarm(ctx, swarm.id, deps);

  assert.equal(deps.calls.length, 2, "the leaf behind the busy one was still offered to the door");
  assert.equal(result?.workerRunIds.length, 1);
  assert.equal((await read(first.id)).status, "assigned", "the leaf somebody is already on is left alone");
  assert.equal((await read(second.id)).status, "working", "and the one behind it started");
  assert.deepEqual(queuedRunIds(), [result!.workerRunIds[0]]);
});

test("a swarm at its ceiling is not asked again for the leaves behind", async () => {
  const swarm = await makeSwarm({ status: "running" });
  await makeTask(swarm.id, { title: "first", status: "assigned", position: 0 });
  await makeTask(swarm.id, { title: "second", status: "assigned", position: 1 });

  const deps = starter([SWARM_FULL]);
  const result = await tickSwarm(ctx, swarm.id, deps);

  assert.equal(deps.calls.length, 1, "a full swarm has no room for any of them");
  assert.deepEqual(result?.workerRunIds, []);
});

test("no worker is spawned before somebody starts the swarm", async () => {
  const swarm = await makeSwarm({ status: "planning" });
  await makeTask(swarm.id, { status: "assigned" });
  const deps = starter();
  const result = await tickSwarm(ctx, swarm.id, deps);
  assert.deepEqual(result?.workerRunIds, [], "a plan being written is not work to do");
  assert.ok(
    deps.calls.every((call) => call.type === "swarm" && call.role !== "worker"),
    "nothing asked for a worker",
  );
  assert.deepEqual(queuedRunIds(), [], "and nothing was queued");
});

/**
 * The rule the two assertions above are instances of, said once
 * against the rows: every run this swarm has that is waiting to start
 * was handed to the `run.execute` workers by the tick that started it.
 */
test("every run a tick starts is queued for the executor, and none is left sitting", async () => {
  const swarm = await makeSwarm({ status: "running" });
  await makeTask(swarm.id, { title: "first", status: "assigned", position: 0 });
  await makeTask(swarm.id, { title: "second", status: "assigned", position: 1 });
  await db.insert(swarmMessages).values({ swarmId: swarm.id, text: "also do X", userId: "u1" });

  const result = await tickSwarm(ctx, swarm.id, starter());
  assert.ok(result);
  assert.ok(result.plannerRunId, "the message woke the planner");
  assert.equal(result.workerRunIds.length, 2, "and both ready leaves got a worker");

  const rows = await db.select().from(agentRuns).where(eq(agentRuns.swarmId, swarm.id));
  const waiting = rows.filter((row) => row.status === "queued").map((row) => row.id);
  assert.equal(waiting.length, 3);
  assert.deepEqual(
    [...queuedRunIds()].sort(),
    [...waiting].sort(),
    "a queued run row with no job is a swarm that deadlocks until a restart",
  );
});

test("the landing queue keeps one in flight and drops what was withdrawn", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const done = await makeTask(swarm.id, { title: "landed", status: "done" });
  const dropped = await makeTask(swarm.id, { title: "withdrawn", status: "cancelled" });
  await db.insert(swarmLandings).values([
    { swarmId: swarm.id, taskId: done.id, position: 0, branchName: "swarm/x/1" },
    { swarmId: swarm.id, taskId: dropped.id, position: 1, branchName: "swarm/x/2" },
  ]);

  const landed: string[] = [];
  const deps = { ...starter(), startLanding: async (_tx: unknown, id: string) => void landed.push(id) };
  const result = await tickSwarm(ctx, swarm.id, deps as unknown as SwarmTickDeps);

  const rows = await db.select().from(swarmLandings).where(eq(swarmLandings.swarmId, swarm.id));
  const byTask = new Map(rows.map((row) => [row.taskId, row]));
  assert.equal(byTask.get(done.id)!.status, "landing", "the front of the queue is in flight");
  assert.equal(byTask.get(done.id)!.attempt, 1, "and counted as an attempt");
  assert.equal(byTask.get(dropped.id)!.status, "cancelled", "a landing for withdrawn work is dropped");
  assert.deepEqual(landed, [byTask.get(done.id)!.id], "exactly one landing was handed over");
  assert.equal(result?.landingId, byTask.get(done.id)!.id);
});

test("a conflict whose resolver has finished is tried again, rather than holding forever", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const stuck = await makeTask(swarm.id, { title: "stuck", status: "working", report: "did it" });
  const [resolver] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: stuck.id,
      role: "resolver",
      agentProfileId: PROFILE,
      prompt: "",
      status: "running",
    })
    .returning();
  const [landing] = await db
    .insert(swarmLandings)
    .values({ swarmId: swarm.id, taskId: stuck.id, position: 0, status: "conflicted", resolverRunId: resolver!.id })
    .returning();

  const landed: string[] = [];
  const deps = { ...starter(), startLanding: async (_tx: unknown, id: string) => void landed.push(id) };

  // While the resolver works, nothing moves: the queue is held on
  // purpose, because the branch it is holding has not been reconciled.
  await tickSwarm(ctx, swarm.id, deps as unknown as SwarmTickDeps);
  assert.deepEqual(landed, []);
  const held = await db.select().from(swarmLandings).where(eq(swarmLandings.id, landing!.id));
  assert.equal(held[0]!.status, "conflicted");

  /**
   * And once it ends, the row goes back to the queue. Without this the
   * swarm's first conflict is the last thing it ever does: the row
   * holds everything behind it and nothing anywhere moves it.
   */
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, resolver!.id));
  const result = await tickSwarm(ctx, swarm.id, deps as unknown as SwarmTickDeps);
  assert.deepEqual(landed, [landing!.id], "the reconciled branch is tried again");
  assert.equal(result?.landingId, landing!.id);
  assert.equal(result?.landingPromoted, true);
  const retried = await db.select().from(swarmLandings).where(eq(swarmLandings.id, landing!.id));
  assert.equal(retried[0]!.status, "landing");
  assert.equal(retried[0]!.resolverRunId, resolver!.id, "and it still names the resolver, so it is not tried twice");
});

test("a conflict with nobody on it has an agent put on it, every pass until one is", async () => {
  /**
   * The state a swarm's queue used to end in.
   *
   * A conflict holds the queue on purpose, and the row is marked
   * conflicted before a resolver is started because a resolver refuses
   * to start with no conflict waiting. So the start can fail: a team at
   * its plan limit is the routine way, and busy is another. The row
   * then said "conflicted" with no resolver named, this step skipped it
   * (`if (!landing.resolverRunId) continue`) and returned nothing while
   * any conflict stood, and nothing else in the swarm moves a
   * conflicted row. One conflict and the swarm's whole queue was over,
   * with cancelling the swarm the only way out.
   */
  const swarm = await makeSwarm({ status: "running" });
  // Told about already, the way a leaf whose branch the planner
  // accepted always has been, so the only run either pass could start
  // is the resolver.
  const stuck = await makeTask(swarm.id, {
    title: "stuck",
    status: "working",
    report: "did it",
    flags: { plannerToldAt: "2026-01-01T00:00:00.000Z" },
  });
  const waiting = await makeTask(swarm.id, { title: "waiting", status: "done" });
  const [landing] = await db
    .insert(swarmLandings)
    .values({ swarmId: swarm.id, taskId: stuck.id, position: 0, status: "conflicted", error: "CONFLICT in one file" })
    .returning();
  await db.insert(swarmLandings).values({ swarmId: swarm.id, taskId: waiting.id, position: 1 });

  const landed: string[] = [];
  // The plan limit first, which is transient, and then room.
  const refused = {
    ...starter([{ outOfCompute: "this team has used its agent hours for the period." }]),
    startLanding: async (_tx: unknown, id: string) => void landed.push(id),
  };
  const held = await tickSwarm(ctx, swarm.id, refused as unknown as SwarmTickDeps);
  assert.deepEqual(held?.resolverRunIds, [], "nothing could be started this pass");
  assert.deepEqual(landed, [], "and the conflict still holds the queue");
  const stillConflicted = await db.select().from(swarmLandings).where(eq(swarmLandings.id, landing!.id));
  assert.equal(stillConflicted[0]!.status, "conflicted");
  assert.equal(stillConflicted[0]!.resolverRunId, null);

  const deps = { ...starter(), startLanding: async (_tx: unknown, id: string) => void landed.push(id) };
  const result = await tickSwarm(ctx, swarm.id, deps as unknown as SwarmTickDeps);
  assert.equal(result?.resolverRunIds.length, 1, "the next pass asks again, which is the exit the queue needs");
  const resolverRunId = result!.resolverRunIds[0]!;
  const [resolver] = await db.select().from(agentRuns).where(eq(agentRuns.id, resolverRunId));
  assert.equal(resolver!.role, "resolver");
  assert.equal(resolver!.swarmTaskId, stuck.id);
  const withResolver = await db.select().from(swarmLandings).where(eq(swarmLandings.id, landing!.id));
  assert.equal(withResolver[0]!.resolverRunId, resolverRunId, "named on the row, so a second is not asked for");
  assert.ok(queuedRunIds().includes(resolverRunId), "and handed to the queue: a run with no job never starts");
});

test("a conflict nothing could ever resolve fails the leaf and lets the queue move", async () => {
  /**
   * The other half. A swarm whose template has no worker agent has
   * nothing that could be put on a conflict, this pass or any other, so
   * asking again for ever would be the same wedge one step along. The
   * leaf fails with a sentence a person can act on, which frees the
   * queue and puts the leaf in front of the planner.
   */
  const [template] = await db
    .insert(swarmTemplates)
    .values({ ownerId: "u1", name: "no worker", plannerProfileId: PROFILE, maxWorkers: 2, workerIsolation: "worktree" })
    .returning();
  const swarm = await makeSwarm({ status: "running", templateId: template!.id });
  const stuck = await makeTask(swarm.id, { title: "stuck", status: "working", report: "did it", position: 0 });
  const waiting = await makeTask(swarm.id, { title: "waiting", status: "done", position: 1 });
  const [blocked] = await db
    .insert(swarmLandings)
    .values({ swarmId: swarm.id, taskId: stuck.id, position: 0, status: "conflicted", error: "CONFLICT in one file" })
    .returning();
  const [next] = await db
    .insert(swarmLandings)
    .values({ swarmId: swarm.id, taskId: waiting.id, position: 1 })
    .returning();

  const landed: string[] = [];
  const deps = { ...starter(), startLanding: async (_tx: unknown, id: string) => void landed.push(id) };
  const result = await tickSwarm(ctx, swarm.id, deps as unknown as SwarmTickDeps);

  const rows = await db.select().from(swarmLandings).where(eq(swarmLandings.swarmId, swarm.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get(blocked!.id)!.status, "failed");
  assert.match(byId.get(blocked!.id)!.error ?? "", /no worker agent/);
  assert.match(byId.get(blocked!.id)!.error ?? "", /CONFLICT in one file/, "what git said is kept as well");
  const leaf = await read(stuck.id);
  assert.equal(leaf.status, "failed", "which is what puts it in front of the planner");
  assert.equal(leaf.attention, "conflict");
  assert.equal((leaf.flags as { plannerToldAt?: string }).plannerToldAt, undefined);

  // And the branch behind it is landing, in the same pass.
  assert.equal(byId.get(next!.id)!.status, "landing");
  assert.deepEqual(landed, [next!.id]);
  assert.equal(result?.landingId, next!.id);
});

test("a promotion whose job could not be sent gives the claim back", async () => {
  /**
   * A row that says "landing" with no job behind it is the one state
   * the queue cannot leave on its own: the partial unique index refuses
   * every other landing in that swarm, this tick is retried and
   * deliberately does not re-enqueue a landing already in flight,
   * nothing sweeps a claimed row, and the boot time sweep is the next
   * restart. So a send that throws puts the row back.
   */
  const swarm = await makeSwarm({ status: "running" });
  const done = await makeTask(swarm.id, { title: "ready to land", status: "done" });
  const [landing] = await db
    .insert(swarmLandings)
    .values({ swarmId: swarm.id, taskId: done.id, position: 0 })
    .returning();

  const boss = ctx.boss as unknown as { send: (queue: string, data: unknown) => Promise<string> };
  const real = boss.send;
  boss.send = async (queue: string, data: unknown) => {
    if (queue === "swarm.land") throw new Error("the queue is not reachable");
    return real(queue, data);
  };
  try {
    await assert.rejects(
      tickSwarm(ctx, swarm.id, { ...starter(), startLanding: async () => {} } as unknown as SwarmTickDeps),
      /not reachable/,
      "the failure is not swallowed: pg-boss retries the tick",
    );
  } finally {
    boss.send = real;
  }

  const [row] = await db.select().from(swarmLandings).where(eq(swarmLandings.id, landing!.id));
  assert.equal(row!.status, "queued", "back at the front of the queue, for the retried tick to promote again");
  assert.equal(row!.startedAt, null);
  assert.equal(row!.attempt, 0, "and the attempt that never happened is not counted against the branch");
});

test("a conflict holds the queue rather than letting the next branch overtake it", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const stuck = await makeTask(swarm.id, { title: "stuck", status: "done" });
  const waiting = await makeTask(swarm.id, { title: "waiting", status: "done" });
  await db.insert(swarmLandings).values([
    { swarmId: swarm.id, taskId: stuck.id, position: 0, status: "conflicted" },
    { swarmId: swarm.id, taskId: waiting.id, position: 1 },
  ]);

  const landed: string[] = [];
  const deps = { ...starter(), startLanding: async (_tx: unknown, id: string) => void landed.push(id) };
  const result = await tickSwarm(ctx, swarm.id, deps as unknown as SwarmTickDeps);
  assert.equal(result?.landingId, null);
  assert.deepEqual(landed, [], "nothing lands while a conflict is unresolved");
});

test("a swarm that is gone ticks to nothing rather than throwing", async () => {
  const answer = await tickSwarm(ctx, "44444444-4444-4444-4444-444444444444", starter());
  assert.equal(answer, null);
});

test("status changes are announced on the project's board, after the writes", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const group = await makeTask(swarm.id, { nodeType: "plan", title: "G" });
  const leaf = await makeTask(swarm.id, { parentId: group.id, status: "done" });

  await tickSwarm(ctx, swarm.id, starter());
  const kinds = emitted.map((event) => event.type);
  assert.ok(kinds.includes("swarm_task_updated"), "the group's roll up is announced");
  assert.ok(kinds.includes("swarm_updated"), "and so is the swarm's own status");
  const taskEvent = emitted.find(
    (event) => event.type === "swarm_task_updated" && "taskId" in event && event.taskId === group.id,
  );
  assert.ok(taskEvent && "status" in taskEvent && taskEvent.status === "done");
  // Nothing an agent wrote travels on the bus: a client refetches.
  assert.ok(
    emitted.every((event) => !Object.values(event).some((value) => value === "T")),
    "no task title rides the event",
  );
  assert.equal((await read(leaf.id)).status, "done");
});

/* ------------------------------------------------------------------ *
 * A worker that stopped, and what the planner is told about it.
 * ------------------------------------------------------------------ */

/** A run row on a leaf, in whatever state the case needs. */
async function runOn(
  swarmId: string,
  taskId: string,
  status: (typeof agentRuns.$inferInsert)["status"],
  error?: string,
) {
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId,
      swarmTaskId: taskId,
      role: "worker",
      agentProfileId: PROFILE,
      prompt: "",
      status,
      ...(error ? { error } : {}),
    })
    .returning();
  await db.update(swarmTasks).set({ assignedRunId: run!.id }).where(eq(swarmTasks.id, taskId));
  return run!;
}

test("a leaf whose worker stopped without reporting fails, rather than waiting forever", async () => {
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id, { title: "abandoned", status: "working" });
  await runOn(swarm.id, leaf.id, "failed", "the agent ran out of context");

  await tickSwarm(ctx, swarm.id, starter());
  const row = await read(leaf.id);
  assert.equal(row.status, "failed", "nothing else in a swarm notices a worker that simply stopped");
  assert.equal(row.attention, "failed");
  assert.match(String((row.flags as { workerStopped?: string }).workerStopped), /ran out of context/);
});

test("a leaf failed for a worker that stopped is news to the planner, even once", async () => {
  /**
   * The latch, and why it is not a caller's to remember.
   *
   * plannerToldAt is set once per leaf, when its news is folded into a
   * wake, and the wake's query requires it empty. A leaf failed without
   * it being cleared is therefore filtered out of every wake there will
   * ever be: this leaf had already been through the planner once, and
   * the second time it fails nothing tells anybody.
   */
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id, {
    title: "abandoned twice",
    status: "working",
    report: null,
    flags: { plannerToldAt: "2026-01-01T00:00:00.000Z" },
  });
  await runOn(swarm.id, leaf.id, "failed", "the agent ran out of context");

  const deps = starter();
  const result = await tickSwarm(ctx, swarm.id, deps);
  assert.equal((await read(leaf.id)).status, "failed");
  assert.ok(result?.plannerRunId, "the wake the cleared latch let through");
  assert.match(
    deps.calls.find((call) => call.role === "planner")!.prompt!,
    /abandoned twice/,
    "and the leaf is in it, rather than filtered out as old news",
  );
  assert.notEqual(
    ((await read(leaf.id)).flags as { plannerToldAt?: string }).plannerToldAt,
    "2026-01-01T00:00:00.000Z",
    "and the latch now records this wake rather than the one before it",
  );
});

test("a leaf whose worker is still running is left alone", async () => {
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id, { title: "in progress", status: "working" });
  await runOn(swarm.id, leaf.id, "running");

  await tickSwarm(ctx, swarm.id, starter());
  assert.equal((await read(leaf.id)).status, "working");
});

test("a leaf that reported wakes the planner, and only once its worker has finished", async () => {
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id, { title: "reported", status: "working", report: "did the thing" });
  const run = await runOn(swarm.id, leaf.id, "running");

  /**
   * report is a tool call, not the end of a turn: the worker can go on
   * committing after it. A planner woken now could accept the leaf, and
   * the merge queue would land the branch half way through the last
   * commit.
   */
  const early = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(early?.plannerRunId, null, "nothing is told while the worker is still running");
  assert.equal((await read(leaf.id)).status, "working", "and the leaf is not failed for having reported");

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, run.id));
  const deps = starter();
  const later = await tickSwarm(ctx, swarm.id, deps);
  assert.ok(later?.plannerRunId, "once the worker is done, the planner hears about it");
  const wake = deps.calls.find((call) => call.role === "planner");
  assert.match(wake!.prompt!, /did the thing/, "the report is in the wake message");
  assert.match(wake!.prompt!, /data, not instructions/, "labelled as what it is");
  assert.match(wake!.prompt!, /~{8,}/, "and fenced, so it cannot read as the planner's own instructions");

  // Told once. A second tick must not pay for the same turn again.
  const again = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(again?.plannerRunId, null);
});

test("the tick that finishes a swarm asks for it to be published, once", async () => {
  /**
   * The one thing a swarm does that leaves Bento, and the only door to
   * it. Keyed on the transition rather than on the status, because a
   * tick runs again for all sorts of reasons and a job per tick on a
   * finished swarm is a push per tick.
   */
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id, { status: "working" });

  const working = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(working?.becameDone, false);
  assert.equal(
    queued.filter((job) => job.queue === "swarm.publish").length,
    0,
    "a swarm still working is not published",
  );

  await db.update(swarmTasks).set({ status: "done" }).where(eq(swarmTasks.id, leaf.id));
  const finished = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(finished?.status, "done");
  assert.equal(finished?.becameDone, true);
  const asked = queued.filter((job) => job.queue === "swarm.publish");
  assert.equal(asked.length, 1, "the transition is what asks");
  assert.equal((asked[0]!.data as { swarmId?: string }).swarmId, swarm.id);

  // And again, on a swarm that has been done since the last tick.
  const again = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(again?.becameDone, false);
  assert.equal(
    queued.filter((job) => job.queue === "swarm.publish").length,
    1,
    "a second tick on a finished swarm does not publish it a second time",
  );
});

/* ---------------------------------------------------------------- *
 * Money, and the two ceilings that stop a spawn.
 * ---------------------------------------------------------------- */

/**
 * Out of budget is an ending, and it waits for the agents to stop.
 *
 * Nothing is killed for money: an agent stopped mid edit leaves a
 * branch nobody chose, and its time is spent either way. So the
 * refusal stops the next spawn, and the swarm ends only once the last
 * worker has finished, which is the same rule a card follows.
 */
test("a budget refusal ends the swarm once nothing is running", async () => {
  const swarm = await makeSwarm({ status: "running", budgetUsd: "10" });
  const leaf = await makeTask(swarm.id, { title: "leaf", status: "assigned" });
  const refusal = { outOfCompute: "This swarm has spent its $10.00 budget.", cap: "budget" as const };

  const [running] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      role: "worker",
      agentProfileId: PROFILE,
      prompt: "",
      status: "running",
    })
    .returning();
  assert.ok(running);

  const held = await tickSwarm(ctx, swarm.id, starter([refusal]));
  assert.equal(held?.spawnRefusal, refusal.outOfCompute);
  assert.notEqual((await readSwarm(swarm.id)).status, "budget_exhausted", "the worker that is going finishes");
  assert.equal((await read(leaf.id)).attention, "budget", "and the leaf says which ceiling it is waiting on");

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, running.id));
  const ended = await tickSwarm(ctx, swarm.id, starter([refusal]));
  assert.equal(ended?.status, "budget_exhausted");
  const after = await readSwarm(swarm.id);
  assert.equal(after.status, "budget_exhausted");
  assert.equal(after.pausedReason, "budget");
});

/**
 * Out of agent hours is a pause, because it comes back on its own.
 *
 * The period rolls over, or somebody allows overage, and neither is an
 * event this server hears about: the swarm has to ask again. So it is
 * paused with the reason recorded, and a tick that manages to start
 * something takes it straight back out.
 */
test("a plan limit pauses the swarm, and a later tick that can spawn resumes it", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const leaf = await makeTask(swarm.id, { title: "leaf", status: "assigned" });

  const stalled = await tickSwarm(
    ctx,
    swarm.id,
    starter([{ outOfCompute: "This team has used its agent hours.", cap: "plan" }]),
  );
  assert.equal(stalled?.status, "paused");
  const paused = await readSwarm(swarm.id);
  assert.equal(paused.pausedReason, "plan_limit");
  assert.equal((await read(leaf.id)).attention, "plan_limit");

  const resumed = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(resumed?.workerRunIds.length, 1, "the spawn is asked for again rather than waiting for a person");
  assert.equal(resumed?.status, "running");
  const back = await readSwarm(swarm.id);
  assert.equal(back.status, "running");
  assert.equal(back.pausedReason, null);
  assert.equal((await read(leaf.id)).attention, null, "and the leaf stops saying it is waiting");
});

/** A swarm a person paused is not a swarm a ceiling paused. */
test("a swarm somebody paused by hand is left alone", async () => {
  const swarm = await makeSwarm({ status: "paused", pausedReason: "manual" });
  await makeTask(swarm.id, { title: "leaf", status: "assigned" });

  const deps = starter();
  const result = await tickSwarm(ctx, swarm.id, deps);
  assert.equal(deps.calls.filter((call) => call.role === "worker").length, 0, "nothing is spawned");
  assert.equal(result?.status, "paused");
  assert.equal((await readSwarm(swarm.id)).pausedReason, "manual");
});

/**
 * The planner is told the money is nearly gone, once.
 *
 * Told in time it can spend the remainder on the leaf that matters.
 * Told every tick it would spend a turn a minute reading the same
 * sentence, which is itself money.
 */
test("the planner is warned once when less than one run's worth of budget is left", async () => {
  const swarm = await makeSwarm({ status: "running", budgetUsd: "10", spentMeasuredUsd: "9.80" });
  await makeTask(swarm.id, { title: "leaf", status: "open" });

  const first = await tickSwarm(ctx, swarm.id, starter());
  assert.ok(first?.plannerRunId, "the warning is delivered as a planner turn");
  const notices = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.source, "system", "Bento's own words, not a person's");
  assert.match(notices[0]!.text, /budget/);
  assert.ok((await readSwarm(swarm.id)).budgetWarnedAt, "and the latch is set");

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.swarmId, swarm.id));
  await tickSwarm(ctx, swarm.id, starter());
  const after = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  assert.equal(after.length, 1, "one budget, one warning");
});

/**
 * A ceiling stops a swarm starting work. It does not stop the work
 * that was already going from finishing the plan.
 *
 * The workers that were running when the budget was reached are never
 * killed, so their landings can be the last work the tree had. Without
 * this the swarm would sit at "out of budget" over a finished tree,
 * publish nothing, and wait for somebody to notice.
 */
test("a swarm that ran out of budget still finishes when its last worker lands", async () => {
  const swarm = await makeSwarm({ status: "budget_exhausted", pausedReason: "budget", budgetUsd: "10" });
  const leaf = await makeTask(swarm.id, { title: "the last one", status: "working" });

  const held = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(held?.status, "budget_exhausted", "while the work is in flight, the ending stands");

  await db.update(swarmTasks).set({ status: "done" }).where(eq(swarmTasks.id, leaf.id));
  const finished = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(finished?.status, "done", "a swarm whose every task is done is done");
  assert.equal(finished?.becameDone, true, "and it publishes, rather than waiting for a person");
});

/** A template with no worker does not hold up a leaf that has its own. */
test("a leaf with its own agent starts even when the template names none", async () => {
  const [bare] = await db
    .insert(swarmTemplates)
    .values({
      ownerId: "u1",
      name: "No worker",
      plannerProfileId: PROFILE,
      workerProfileId: null,
      workerIsolation: "worktree",
    })
    .returning();
  const swarm = await makeSwarm({ status: "running", templateId: bare!.id });
  await makeTask(swarm.id, { title: "template's", status: "assigned", position: 0 });
  const chosen = await makeTask(swarm.id, {
    title: "reassigned by hand",
    status: "assigned",
    position: 1,
    agentProfileId: PROFILE,
  });

  const deps = starter();
  const result = await tickSwarm(ctx, swarm.id, deps);
  assert.equal(result?.workerRunIds.length, 1, "the one that has an agent starts");
  assert.equal(deps.calls.at(-1)?.swarmTaskId, chosen.id);
  assert.equal((await read(chosen.id)).status, "working");
});

/**
 * What a restart picks back up.
 *
 * A swarm's state is in its rows, so a deploy loses only the jobs that
 * were in flight, and this is what puts them back. The one that has to
 * be here and is easiest to leave out is the swarm paused on a plan
 * limit: it has nothing running, so it looks like nothing to do, and
 * it is the only state that cannot wake itself. Ticking it is also
 * what registers the watchdog that is the only thing still asking.
 */
test("a restart picks up the swarm that cannot wake itself", async () => {
  const running = await makeSwarm({ status: "running" });
  const onHours = await makeSwarm({ status: "paused", pausedReason: "plan_limit" });
  const byHand = await makeSwarm({ status: "paused", pausedReason: "manual" });
  const finished = await makeSwarm({ status: "done" });

  const ticked = await tickAllLiveSwarms(ctx);
  const asked = queued.filter((job) => job.queue === "swarm.tick").map((job) => (job.data as { swarmId?: string }).swarmId);
  assert.ok(asked.includes(running.id), "a working swarm is ticked");
  assert.ok(asked.includes(onHours.id), "and so is the one waiting on hours it cannot ask for");
  assert.ok(!asked.includes(byHand.id), "a person's pause waits for that person");
  assert.ok(!asked.includes(finished.id), "and a finished swarm is finished");
  assert.equal(ticked, 2);
});

/**
 * The three ceilings, once the tree underneath them has finished.
 *
 * Nothing is killed for a ceiling, so the workers that were going when
 * one bit go on to land their branches, and those landings can be the
 * last work the plan had. All three stops have to let that tree finish
 * and publish. The plan limit is the one that matters most, because it
 * is the only one nobody can lift from here: a swarm left sitting on a
 * finished tree waits for a person who was never told to come.
 */
test("a tree that finished under a ceiling is done, whichever ceiling stopped it", () => {
  assert.equal(swarmStatusFrom("budget_exhausted", ["done", "done"]), "done");
  assert.equal(swarmStatusFrom("timed_out", ["done", "done"]), "done");
  // The plan's hours are a ceiling like the other two. It wears
  // "paused" only because it is the one that comes back on its own.
  assert.equal(swarmStatusFrom("paused", ["done", "done"], "plan_limit"), "done");
  // Still open underneath, so all three hold where they are.
  assert.equal(swarmStatusFrom("budget_exhausted", ["open", "done"]), "budget_exhausted");
  assert.equal(swarmStatusFrom("paused", ["open", "done"], "plan_limit"), "paused");
  // And a person's own pause is still theirs, finished tree or not.
  assert.equal(swarmStatusFrom("paused", ["done", "done"], "manual"), "paused");
});

/**
 * A swarm held on a plan limit, whose last worker landed.
 *
 * The whole path rather than the arithmetic: the tick has to notice,
 * write "done", clear the reason it was paused for, and ask for the
 * publish. Without that the branch is never pushed and no pull request
 * is ever opened, and the only thing still looking at the swarm is a
 * watchdog re-ticking it once a minute for good.
 */
test("a plan limit pause whose tree finished publishes rather than waiting for nobody", async () => {
  const swarm = await makeSwarm({ status: "paused", pausedReason: "plan_limit" });
  await makeTask(swarm.id, { title: "landed and accepted", status: "done" });

  const result = await tickSwarm(ctx, swarm.id, starter());
  assert.equal(result?.status, "done", "a finished tree finishes the swarm");
  assert.equal(result?.becameDone, true, "and the publish is asked for");
  const after = await readSwarm(swarm.id);
  assert.equal(after.status, "done");
  assert.equal(after.pausedReason, null, "nothing is paused any more, so no reason survives");
});

/**
 * The mark a ceiling leaves on a leaf, once that leaf is running.
 *
 * The attention comes off already. The flag it was written beside did
 * not, so a leaf with an agent on it went on telling the drawer that
 * this team was out of agent hours, and kept telling it through every
 * later retry: the drawer prints the flags verbatim.
 */
test("a leaf that starts drops the ceiling it was refused for", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const leaf = await makeTask(swarm.id, { title: "refused once", status: "assigned" });

  await tickSwarm(ctx, swarm.id, starter([{ outOfCompute: "This team has used its agent hours for the month." }]));
  const refused = await read(leaf.id);
  assert.equal(refused.attention, "plan_limit");
  assert.equal(
    (refused.flags as { spawnRefusal?: string }).spawnRefusal,
    "This team has used its agent hours for the month.",
  );

  // The hours come back, and the same leaf starts.
  await db.update(swarms).set({ status: "running", pausedReason: null }).where(eq(swarms.id, swarm.id));
  await tickSwarm(ctx, swarm.id, starter());
  const started = await read(leaf.id);
  assert.equal(started.status, "working");
  assert.equal(started.attention, null);
  assert.equal(
    (started.flags as { spawnRefusal?: string }).spawnRefusal,
    undefined,
    "a leaf that is working asserts no ceiling",
  );
});
