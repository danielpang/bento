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
  swarms,
  type Db,
} from "@bento/db";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import type { NewRun } from "../start-run.js";
import { rollUpStatus, swarmStatusFrom, tickSwarm, type SwarmTickDeps } from "./coordinator.js";

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
    `insert into swarm_templates (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers)
     values ($1,'u1',null,'T',$2,$2,2)`,
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
  answers: ("run" | "busy" | "gone" | { outOfCompute: string })[] = [],
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

test("cost rolls leaves to root, and the swarm's spend is the total", async () => {
  const swarm = await makeSwarm();
  const group = await makeTask(swarm.id, { nodeType: "plan", title: "G", status: "open" });
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
  assert.equal(Number(rolled.costMeasuredUsd), 3.5, "the group's measured cost is its children's");
  assert.equal(Number(rolled.costEstimatedUsd), 0.25);
  assert.equal(Number(rolled.costAssumedUsd), 0.75);
  assert.equal(rolled.status, "done", "both children finished, so the group did");

  const after = await readSwarm(swarm.id);
  assert.equal(Number(after.spentMeasuredUsd), 4, "3.50 in the group plus 0.50 loose");
  assert.equal(Number(after.spentEstimatedUsd), 0.25);
  assert.equal(Number(after.spentAssumedUsd), 0.75);
  assert.equal(after.status, "done", "every root finished");
  assert.equal(result.status, "done");
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

test("workers spawn up to the ceiling, and a plan limit stops the loop on the leaf that hit it", async () => {
  const swarm = await makeSwarm({ status: "running" });
  const first = await makeTask(swarm.id, { title: "first", status: "assigned", position: 0 });
  const second = await makeTask(swarm.id, { title: "second", status: "assigned", position: 1 });
  const third = await makeTask(swarm.id, { title: "third", status: "assigned", position: 2 });

  // The first starts; the second is refused for compute; the third is
  // never asked about, because there is no reason to think it would go
  // any better.
  const deps = starter(["run", { outOfCompute: "This team has used its agent hours for the month." }]);
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
  assert.equal(refused.attention, "budget", "and says on the board why it is waiting");
  assert.equal(
    (refused.flags as { spawnRefusal?: string }).spawnRefusal,
    "This team has used its agent hours for the month.",
  );

  assert.equal((await read(third.id)).attention, null, "the leaf behind it is untouched");
  // A refusal is not a failed tick: pg-boss retrying into the same
  // refusal would say nothing new and would keep saying it.
  assert.equal((await readSwarm(swarm.id)).status, "blocked", "attention holds the swarm's headline");
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
