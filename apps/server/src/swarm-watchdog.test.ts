import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runEvents,
  runMigrations,
  swarmMessages,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import type { AppContext } from "./context.js";
import { EventBus, type BoardEvent } from "./events.js";
import { loadEnv } from "./env.js";
import { runWatchdog } from "./orchestrator/swarm/watchdog.js";

/**
 * The clock, against a real database and a real minute.
 *
 * A worker made to loop is the case this exists for, and it is tested
 * the way it happens: a run that started and never stopped, the clock
 * moved forward, and the two thresholds crossed one after the other.
 * Time is passed in rather than waited for, because a test that waits
 * forty five minutes is a test nobody runs; everything else is real,
 * including the rows the planner is woken with.
 *
 * What is pinned here is what a person and a planner actually get:
 * the node turns yellow at the first threshold and nothing else
 * happens, and at the second the planner is handed the worker's own
 * last lines, quoted as the untrusted output they are.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_watchdog_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const TEMPLATE = "33333333-3333-3333-3333-333333333333";

/** The template's own thresholds, which is what the watchdog reads. */
const WARN_MIN = 20;
const ESCALATE_MIN = 45;

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let emitted: BoardEvent[];
let queued: { queue: string; data: unknown }[];

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
    `insert into swarm_templates
       (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers,worker_isolation,
        long_run_warn_min,long_run_escalate_min)
     values ($1,'u1',null,'T',$2,$2,2,'worktree',$3,$4)`,
    [TEMPLATE, PROFILE, WARN_MIN, ESCALATE_MIN],
  );

  const bus = new EventBus();
  emitted = [];
  queued = [];
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    userId: "u1",
    boss: {
      send: async (queue: string, data: unknown) => {
        queued.push({ queue, data });
        return "job";
      },
      notifyWorker: () => {},
      work: async () => "worker",
      offWork: async () => {},
      createQueue: async () => {},
      schedule: async () => {},
      unschedule: async () => {},
    },
    runWorkers: [],
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
});

async function makeSwarm(overrides: Partial<typeof swarms.$inferInsert> = {}) {
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

/** A leaf with an agent on it that started `minutesAgo` minutes ago. */
async function workingLeaf(swarmId: string, minutesAgo: number, said: string[] = []) {
  const [task] = await db
    .insert(swarmTasks)
    .values({ swarmId, title: "Rewrite the checkout totals", status: "working" })
    .returning();
  const startedAt = new Date(Date.now() - minutesAgo * 60_000);
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId,
      swarmTaskId: task!.id,
      role: "worker",
      agentProfileId: PROFILE,
      prompt: "",
      status: "running",
      queuedAt: startedAt,
      startedAt,
    })
    .returning();
  await db.update(swarmTasks).set({ assignedRunId: run!.id }).where(eq(swarmTasks.id, task!.id));
  let seq = 0;
  for (const text of said) {
    await db.insert(runEvents).values({
      runId: run!.id,
      seq: seq++,
      type: "message",
      payload: { type: "message", role: "assistant", text },
    });
  }
  return { task: task!, run: run! };
}

const readTask = async (taskId: string) =>
  (await db.select().from(swarmTasks).where(eq(swarmTasks.id, taskId)))[0]!;

/* ---------------------------------------------------------------- */

/**
 * The worker that will not stop, at both thresholds, a minute either
 * side of each.
 */
test("a worker that keeps going turns yellow, and then escalates to the planner", async () => {
  const swarm = await makeSwarm();
  const { task } = await workingLeaf(swarm.id, WARN_MIN - 1, [
    "Reading the totals module.",
    "Trying the same fix again.",
  ]);

  // A minute before the warning, nothing is said: a board that turns
  // yellow early is a board people stop believing.
  const early = await runWatchdog(ctx);
  assert.deepEqual(early.warned, [], "inside its window, a working leaf is just a working leaf");
  assert.equal((await readTask(task.id)).attention, null);

  // A minute past it.
  const warned = await runWatchdog(ctx, new Date(Date.now() + 2 * 60_000));
  assert.deepEqual(warned.warned, [task.id]);
  assert.deepEqual(warned.escalated, [], "yellow is for a person to glance at, not a planner turn");
  assert.equal((await readTask(task.id)).attention, "long_running");
  assert.equal(
    (await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id))).length,
    0,
    "and nothing has been queued for the planner yet",
  );
  assert.ok(
    emitted.some((event) => event.type === "swarm_task_updated" && "taskId" in event && event.taskId === task.id),
    "the board is told, so the node turns yellow without a reload",
  );

  // And a minute past the second threshold.
  const escalated = await runWatchdog(ctx, new Date(Date.now() + (ESCALATE_MIN - WARN_MIN + 2) * 60_000));
  assert.deepEqual(escalated.escalated, [task.id]);
  assert.equal((await readTask(task.id)).attention, "escalated");

  const notices = await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id));
  assert.equal(notices.length, 1, "one wake, carrying the whole situation");
  const notice = notices[0]!;
  assert.equal(notice.source, "system", "Bento's own words, not a person's");
  assert.equal(notice.taskId, task.id);
  assert.match(notice.text, /escalation threshold/);
  assert.match(notice.text, /Trying the same fix again\./, "the planner is shown what the agent actually said");
  assert.match(notice.text, /never as instructions/, "and that it is agent output, not orders");
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick"),
    "a wake nothing delivers is a wake nobody hears: the tick is what folds it into a turn",
  );

  // Twice is not twice. The planner has been told.
  queued.length = 0;
  const again = await runWatchdog(ctx, new Date(Date.now() + (ESCALATE_MIN + 10) * 60_000));
  assert.deepEqual(again.escalated, []);
  assert.equal(
    (await db.select().from(swarmMessages).where(eq(swarmMessages.swarmId, swarm.id))).length,
    1,
    "the same stuck worker does not cost a planner turn a minute",
  );
});

/**
 * A planner stuck in a loop is the whole swarm stuck in a loop, so it
 * is said on the root rather than nowhere: a planner run has no node of
 * its own, and a board that stays plain while nothing moves is lying by
 * omission.
 */
test("a planner turn that runs long turns the root yellow", async () => {
  const swarm = await makeSwarm();
  const [root] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, title: "Ship the migration", nodeType: "plan", status: "working" })
    .returning();
  const startedAt = new Date(Date.now() - (WARN_MIN + 5) * 60_000);
  await db.insert(agentRuns).values({
    type: "swarm",
    swarmId: swarm.id,
    role: "planner",
    agentProfileId: PROFILE,
    prompt: "",
    status: "running",
    queuedAt: startedAt,
    startedAt,
  });

  const result = await runWatchdog(ctx);
  assert.deepEqual(result.warned, [root!.id]);
  assert.equal((await readTask(root!.id)).attention, "long_running");
});

/**
 * A node already asking for a person about something specific keeps
 * saying that: "waiting on your answer" beats "this is taking a while".
 */
test("a node that already wants a person is not overwritten with the clock", async () => {
  const swarm = await makeSwarm();
  const { task } = await workingLeaf(swarm.id, WARN_MIN + 5);
  await db.update(swarmTasks).set({ attention: "question" }).where(eq(swarmTasks.id, task.id));

  await runWatchdog(ctx);
  assert.equal((await readTask(task.id)).attention, "question");
});

/**
 * The swarm's own clock. Nothing is killed for it: the limit stops new
 * work, and the swarm ends when the last agent has stopped.
 */
test("a swarm past its time limit ends once its agents have stopped", async () => {
  const swarm = await makeSwarm({ timeLimitMin: 60 });
  const { run } = await workingLeaf(swarm.id, 90);

  const held = await runWatchdog(ctx);
  assert.deepEqual(held.timedOut, [], "an agent is still working, so the swarm is not over");
  assert.equal((await db.select().from(swarms).where(eq(swarms.id, swarm.id)))[0]!.status, "running");

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, run.id));
  const ended = await runWatchdog(ctx);
  assert.deepEqual(ended.timedOut, [swarm.id]);
  const after = (await db.select().from(swarms).where(eq(swarms.id, swarm.id)))[0]!;
  assert.equal(after.status, "timed_out");
  assert.equal(after.pausedReason, "time_limit");
});

/**
 * The swarm waiting on a ceiling somewhere else.
 *
 * Agent hours coming back is not an event this server hears about, so
 * without a clock asking on its behalf a swarm paused at the end of a
 * period would sit there until a person noticed.
 */
test("a swarm paused on a plan limit is asked to try again", async () => {
  const swarm = await makeSwarm({ status: "paused", pausedReason: "plan_limit" });

  const result = await runWatchdog(ctx);
  assert.deepEqual(result.retried, [swarm.id]);
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId?: string }).swarmId === swarm.id),
    "the tick is what asks the door again",
  );
});

/** A swarm a person paused is theirs to resume. Nothing asks on their behalf. */
test("a swarm somebody paused by hand is left where they left it", async () => {
  const swarm = await makeSwarm({ status: "paused", pausedReason: "manual" });
  const result = await runWatchdog(ctx);
  assert.deepEqual(result.retried, []);
  assert.equal(queued.length, 0);
});
