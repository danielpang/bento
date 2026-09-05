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
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import { recoverInterruptedRuns } from "../run-executor.js";
import { tickAllLiveSwarms } from "./coordinator.js";

/**
 * What a restart does to a swarm.
 *
 * A swarm run's moving parts (the exec stream, the abort handle, the
 * stdin channel) live in the process that started it, exactly as a
 * card's do. A deploy kills all of them while the row still says
 * running, and nothing else would ever touch it: the worker drops jobs
 * for runs already picked up, and the run door refuses the swarm as
 * busy. Without recovery the swarm waits forever on a settlement that
 * can never arrive.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_recovery_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let queued: { queue: string; data: unknown; options?: unknown }[];
let emitted: BoardEvent[];

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

  queued = [];
  emitted = [];
  const bus = new EventBus();
  bus.onBoardEvent(PROJECT, (event) => emitted.push(event));
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    driver: new LocalProcessDriver(),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId: "u1",
    boss: {
      send: async (queue: string, data: unknown, options?: unknown) => {
        queued.push({ queue, data, options });
        return "job";
      },
      notifyWorker: () => {},
    } as unknown as AppContext["boss"],
  } as unknown as AppContext;
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from swarms");
  queued.length = 0;
  emitted.length = 0;
});

async function makeSwarm(status: (typeof swarms.$inferSelect)["status"] = "running") {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug: `s-${Math.random().toString(36).slice(2, 8)}`,
      title: "Swarm",
      status,
    })
    .returning();
  return swarm!;
}

test("a swarm run the restart stranded is closed, and its swarm is told", async () => {
  const swarm = await makeSwarm();
  const [task] = await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "leaf" }).returning();
  const [orphan] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      swarmTaskId: task!.id,
      role: "worker",
      agentProfileId: PROFILE,
      prompt: "",
      status: "running",
      executor: "server",
    })
    .returning();

  await recoverInterruptedRuns(ctx);

  const [closed] = await db.select().from(agentRuns).where(eq(agentRuns.id, orphan!.id));
  assert.equal(closed!.status, "failed");
  assert.equal(closed!.error, "interrupted by a server restart");
  assert.ok(closed!.endedAt, "and it has an ending");

  const events = await db.select().from(runEvents).where(eq(runEvents.runId, orphan!.id));
  assert.equal(events.length, 1, "the transcript says what happened, because it is what every client shows");
  assert.match((events[0]!.payload as { text: string }).text, /Bento restarted/);

  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "the reconciler is told, so the leaf does not sit running forever",
  );
  assert.ok(
    !queued.some((job) => job.queue === "gate.evaluate"),
    "and no card's gate was asked about a swarm",
  );
  const board = emitted.find((event) => event.type === "swarm_task_updated");
  assert.ok(board, "the board is told too");
  assert.equal("taskId" in board! ? board.taskId : null, task!.id);
});

test("a swarm run that never started goes back on the queue", async () => {
  const swarm = await makeSwarm();
  const [waiting] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      role: "planner",
      agentProfileId: PROFILE,
      prompt: "",
      status: "queued",
      executor: "server",
    })
    .returning();

  await recoverInterruptedRuns(ctx);

  assert.equal(
    (await db.select().from(agentRuns).where(eq(agentRuns.id, waiting!.id)))[0]!.status,
    "queued",
    "a queued run is requeued, not failed",
  );
  assert.ok(
    queued.some((job) => job.queue === "run.execute" && (job.data as { runId: string }).runId === waiting!.id),
    "its job died with the old process, so a new one is sent",
  );
});

test("a swarm run somebody had already finished is left alone", async () => {
  const swarm = await makeSwarm();
  const [done] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm.id,
      role: "planner",
      agentProfileId: PROFILE,
      prompt: "",
      status: "succeeded",
      executor: "server",
    })
    .returning();
  await recoverInterruptedRuns(ctx);
  const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, done!.id));
  assert.equal(after!.status, "succeeded");
  assert.equal(after!.error, null);
});

test("every swarm that has not finished gets one tick at boot", async () => {
  const live = [await makeSwarm("planning"), await makeSwarm("running"), await makeSwarm("blocked"), await makeSwarm("paused")];
  const over = [await makeSwarm("done"), await makeSwarm("failed"), await makeSwarm("cancelled"), await makeSwarm("draft")];

  const count = await tickAllLiveSwarms(ctx);
  assert.equal(count, live.length);
  const ticked = new Set(
    queued.filter((job) => job.queue === "swarm.tick").map((job) => (job.data as { swarmId: string }).swarmId),
  );
  for (const swarm of live) assert.ok(ticked.has(swarm.id), `${swarm.status} is still going, so it is read again`);
  for (const swarm of over) {
    assert.ok(!ticked.has(swarm.id), `${swarm.status} has nothing left to reconcile`);
  }
  // Coalesced by swarm, so a burst cannot become a tick per event.
  for (const job of queued.filter((job) => job.queue === "swarm.tick")) {
    assert.equal(
      (job.options as { singletonKey?: string }).singletonKey,
      (job.data as { swarmId: string }).swarmId,
    );
  }
});
