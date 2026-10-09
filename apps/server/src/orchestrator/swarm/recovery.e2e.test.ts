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
  sandboxes,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import { singleDriver } from "../sandbox-driver.js";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import { reapStalledRuns, recoverInterruptedRuns } from "../run-executor.js";
import { unbilledReason } from "../../unbilled-reasons.js";
import {
  enqueueSwarmTick,
  ensureSwarmTickWorker,
  hasActiveSwarms,
  stopSwarmTickWorker,
  stopSwarmTickWorkerIfIdle,
  tickAllLiveSwarms,
} from "./coordinator.js";

/**
 * What a restart does to a swarm.
 *
 * A deploy drops the server's stream while the row still says running.
 * Durable sandboxes let the next server reattach and settle the same
 * run. When a sandbox cannot return the run, recovery closes it so the
 * swarm's reconciler can decide what to do next.
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
let workers: string[];
let stopped: string[];
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
  workers = [];
  stopped = [];
  emitted = [];
  const bus = new EventBus();
  bus.onBoardEvent(PROJECT, (event) => emitted.push(event));
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    drivers: singleDriver(new LocalProcessDriver()),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId: "u1",
    boss: {
      send: async (queue: string, data: unknown, options?: unknown) => {
        queued.push({ queue, data, options });
        return "job";
      },
      work: async (queue: string) => {
        workers.push(queue);
        return "worker";
      },
      offWork: async (queue: string) => {
        stopped.push(queue);
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
  workers.length = 0;
  stopped.length = 0;
  emitted.length = 0;
  // The worker registry is keyed by the boss, and this file has one:
  // clear it so each test sees a process that has not started it.
  await stopSwarmTickWorker(ctx);
  stopped.length = 0;
});

async function makeSwarm(status: (typeof swarms.$inferSelect)["status"] = "running") {
  const [swarm] = await db
    .insert(swarms)
    .values({
      workerIsolation: "worktree",
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
      agentStartedAt: new Date(),
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

test("a swarm run a restart cut off before its agent started is not billed, and reads as the sandbox's", async () => {
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
  assert.equal(closed!.error, "Bento restarted before the agent started, so no agent ran.");
  assert.equal(closed!.billable, false);
  assert.equal(unbilledReason(closed!.error)?.id, "restart-before-agent", "so the coordinator restarts it like any sandbox failure");
});

/** A server run that started `minutesAgo`, with these transcript lines, each that long ago too. */
async function stalledRun(
  swarmId: string,
  minutesAgo: number,
  lines: { minutesAgo: number; payload: Record<string, unknown>; type?: string }[],
  agentProfileId: string = PROFILE,
  agentStartedMinutesAgo?: number,
) {
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId,
      role: "planner",
      agentProfileId,
      prompt: "",
      status: "running",
      executor: "server",
      startedAt: new Date(Date.now() - minutesAgo * 60_000),
      ...(agentStartedMinutesAgo !== undefined
        ? { agentStartedAt: new Date(Date.now() - agentStartedMinutesAgo * 60_000) }
        : {}),
    })
    .returning();
  let seq = 0;
  for (const line of lines) {
    await db.insert(runEvents).values({
      runId: run!.id,
      seq: ++seq,
      ts: new Date(Date.now() - line.minutesAgo * 60_000),
      type: line.type ?? "message",
      payload: line.payload,
    });
  }
  return run!;
}

const system = (text: string) => ({ type: "message", role: "system", text });

test("a run that stalled before its agent started is closed, and its swarm is told", async () => {
  /**
   * The shape that found this: a planner whose sandbox answered every
   * provisioning step, then never answered the agent start. pg-boss
   * expired its job, the retry rightly did nothing, and the row said
   * running for the whole run timeout while holding the swarm's one
   * planner slot.
   */
  const swarm = await makeSwarm();
  const stalled = await stalledRun(swarm.id, 46, [
    { minutesAgo: 44, payload: system("Starting a Modal sandbox") },
    { minutesAgo: 42, payload: system("Repository bento is ready on branch swarm/x.") },
  ]);
  // The handler that is still waiting on the sandbox, in this process.
  const controller = new AbortController();
  ctx.running.set(stalled.id, controller);

  const closed = await reapStalledRuns(ctx);

  assert.deepEqual(closed, [stalled.id]);
  assert.ok(controller.signal.aborted, "the waiting handler is told to stop, so it cannot start an agent later");
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, stalled.id));
  assert.equal(row!.status, "failed");
  assert.match(row!.error!, /^The sandbox stopped responding before the agent started/);
  assert.equal(unbilledReason(row!.error)?.id, "sandbox-stalled", "and is not billed, so the coordinator restarts it");
  const lines = await db.select().from(runEvents).where(eq(runEvents.runId, stalled.id));
  assert.match(
    (lines.at(-1)!.payload as { text: string }).text,
    /stopped responding before the agent started/,
    "the transcript says why it ended",
  );
  assert.ok(
    queued.some((job) => job.queue === "swarm.tick" && (job.data as { swarmId: string }).swarmId === swarm.id),
    "and the reconciler is told, so a new planner can be woken",
  );
  ctx.running.delete(stalled.id);
});

test("a run whose agent has spoken, or that is not yet stalled, is left alone", async () => {
  const swarm = await makeSwarm();
  // An agent that started and then went quiet: a long command, not a stall.
  const quietAgent = await stalledRun(swarm.id, 60, [
    { minutesAgo: 58, payload: system("Starting codex in the sandbox.") },
    { minutesAgo: 57, type: "init", payload: { type: "init", sessionId: "s1" } },
  ]);
  // Still inside the window: repository setup can be silent for twenty minutes.
  const settingUp = await stalledRun(swarm.id, 25, [
    { minutesAgo: 22, payload: system("Setting up bento: pnpm install") },
  ]);

  const closed = await reapStalledRuns(ctx);

  assert.deepEqual(closed, []);
  for (const run of [quietAgent, settingUp]) {
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    assert.equal(row!.status, "running");
  }
});

test("a text-mode agent that was launched is working, and a person's prompt is not the agent speaking", async () => {
  /**
   * dsh prints nothing until it exits, so its launch line is the last
   * line for as long as it works; agentStartedAt says it was exec'd. And the executor opens a stage run's
   * transcript with the person's prompt as a user line, which says
   * nothing about whether the agent ever started.
   */
  const DSH = "33333333-3333-3333-3333-333333333333";
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'D','dsh','deepseek') on conflict do nothing`,
    [DSH],
  );
  const swarm = await makeSwarm();
  const working = await stalledRun(
    swarm.id,
    60,
    [
      { minutesAgo: 58, payload: system("Repository bento is ready on branch swarm/x.") },
      { minutesAgo: 57, payload: system("Starting dsh in the sandbox.") },
    ],
    DSH,
    57,
  );
  const neverLaunched = await stalledRun(
    swarm.id,
    60,
    [{ minutesAgo: 58, payload: system("Repository bento is ready on branch swarm/x.") }],
    DSH,
  );
  const prompted = await stalledRun(swarm.id, 60, [
    { minutesAgo: 59, payload: { type: "message", role: "user", text: "Fix the login page" } },
    { minutesAgo: 58, payload: system("Starting a Modal sandbox") },
  ]);

  const closed = await reapStalledRuns(ctx);

  assert.deepEqual(new Set(closed), new Set([neverLaunched.id, prompted.id]));
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, working.id));
  assert.equal(row!.status, "running", "the launched dsh agent keeps working");
});

test("planner and worker runs reattach with only their missing Docker output", { timeout: 30_000 }, async () => {
  for (const role of ["planner", "worker"] as const) {
    const swarm = await makeSwarm();
    const [task] = role === "worker"
      ? await db.insert(swarmTasks).values({ swarmId: swarm.id, title: "leaf" }).returning()
      : [];
    const [sandbox] = await db.insert(sandboxes).values({
      projectId: PROJECT,
      swarmId: swarm.id,
      ...(task ? { swarmTaskId: task.id } : {}),
      provider: "docker",
      externalId: `swarm-reattach-${swarm.id}`,
      status: "busy",
      workdir: "/workspace",
    }).returning();
    const [run] = await db.insert(agentRuns).values({
      type: "swarm",
      swarmId: swarm.id,
      ...(task ? { swarmTaskId: task.id } : {}),
      role,
      agentProfileId: PROFILE,
      sandboxId: sandbox!.id,
      prompt: "Continue the work",
      status: "running",
      executor: "server",
      startedAt: new Date(),
    }).returning();
    await db.insert(runEvents).values({
      runId: run!.id,
      seq: 1,
      type: "message",
      payload: { type: "message", role: "assistant", text: "Before deploy.", sandboxCursor: 1 },
    });

    const attached: { key?: string; after?: number }[] = [];
    const original = ctx.drivers;
    ctx.drivers = singleDriver({
      provider: "docker",
      workspace: "host",
      supportsStdin: false,
      async provision(): Promise<never> { throw new Error("must not provision"); },
      exec: async function* () { yield { kind: "exit" as const, exitCode: 1 }; },
      async attach(_handle: SandboxHandle, _argv: string[], options?: { sessionKey?: string; afterCursor?: number }) {
        attached.push({ key: options?.sessionKey, after: options?.afterCursor });
        return (async function* () {
          yield { kind: "stdout" as const, data: '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"After deploy."}]}}\n', cursor: 2 };
          yield { kind: "stdout" as const, data: '{"type":"result","subtype":"success","is_error":false,"session_id":"fake-session-1","total_cost_usd":0.01,"num_turns":1}\n', cursor: 3 };
          yield { kind: "exit" as const, exitCode: 0, cursor: 4 };
        })();
      },
      async destroy() {},
    } as SandboxDriver);
    try {
      await recoverInterruptedRuns(ctx);
      const deadline = Date.now() + 10_000;
      let status = "running";
      while (Date.now() < deadline) {
        status = (await db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, run!.id)))[0]!.status;
        if (status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(status, "succeeded", `${role} keeps its run across the deploy`);
      assert.deepEqual(attached, [{ key: run!.id, after: 1 }]);
      const events = (await db.select({ payload: runEvents.payload }).from(runEvents).where(eq(runEvents.runId, run!.id)))
        .map((row) => row.payload as { text?: string; sandboxCursor?: number });
      assert.equal(events.filter((event) => event.text === "Before deploy.").length, 1);
      assert.equal(events.filter((event) => event.text === "After deploy.").length, 1);
      assert.ok(events.some((event) => event.sandboxCursor === 2));
    } finally {
      ctx.drivers = original;
    }
  }
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

test("every swarm still working gets one tick at boot", async () => {
  const live = [await makeSwarm("planning"), await makeSwarm("running"), await makeSwarm("blocked")];
  const over = [
    await makeSwarm("paused"),
    await makeSwarm("done"),
    await makeSwarm("failed"),
    await makeSwarm("cancelled"),
    await makeSwarm("draft"),
  ];

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

/**
 * What an idle deployment pays for swarms.
 *
 * The tick worker polls every two seconds, which is the pace a person
 * watching a board needs and a pure waste on a deployment that has
 * never started a swarm. Most have not, and pg-boss has no push, so an
 * always-registered worker is a query every two seconds forever on
 * every install, which is the shape of cost this codebase has been
 * billed for before.
 */
test("a deployment with nothing in flight registers no tick worker", async () => {
  for (const status of ["paused", "done", "failed", "cancelled", "draft"] as const) await makeSwarm(status);

  assert.equal(await hasActiveSwarms(ctx), false, "none of these has anything to reconcile");
  const count = await tickAllLiveSwarms(ctx);

  assert.equal(count, 0);
  assert.deepEqual(workers, [], "so no worker polls for them");
});

test("the first tick starts the worker, and one start covers the rest", async () => {
  const first = await makeSwarm("running");
  const second = await makeSwarm("planning");

  await enqueueSwarmTick(ctx, first.id);
  assert.deepEqual(workers, ["swarm.tick"], "the door that queues the job is the door that starts the worker");

  await enqueueSwarmTick(ctx, second.id);
  assert.deepEqual(workers, ["swarm.tick"], "and a second swarm does not register a second worker");

  // The worker before the job, or the job waits for the next restart.
  assert.equal(queued.filter((job) => job.queue === "swarm.tick").length, 2);
});

test("the worker stops once the last swarm settles", async () => {
  const swarm = await makeSwarm("running");
  await enqueueSwarmTick(ctx, swarm.id);
  assert.deepEqual(workers, ["swarm.tick"]);

  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, swarm.id));
  assert.equal(await hasActiveSwarms(ctx), false);
  await stopSwarmTickWorker(ctx);
  assert.deepEqual(stopped, ["swarm.tick"], "an idle deployment stops paying for the poll");

  // And a new swarm starts it again, rather than waiting for a deploy.
  const next = await makeSwarm("running");
  await enqueueSwarmTick(ctx, next.id);
  assert.deepEqual(workers, ["swarm.tick", "swarm.tick"]);
});

/**
 * The window between deciding to stop and having stopped.
 *
 * Starting the worker and stopping it are two steps each: mark the
 * boss, then talk to pg-boss. A tick that arrived in between saw a
 * mark that no longer had a worker behind it, or registered one the
 * stop then took away, and either way the job sat in the queue until
 * something else started a swarm. Driven rather than argued about: the
 * stop is held open, a tick is enqueued into the gap, and the order
 * the boss was actually called in is the assertion.
 */
test("a tick enqueued while the worker is stopping waits for the stop rather than racing it", async () => {
  const calls: string[] = [];
  let releaseOffWork: (() => void) | null = null;
  const holding = {
    ...ctx,
    boss: {
      work: async () => {
        calls.push("work");
        return "worker";
      },
      offWork: async () => {
        calls.push("offWork:start");
        await new Promise<void>((resolve) => {
          releaseOffWork = resolve;
        });
        calls.push("offWork:end");
      },
      send: async () => {
        calls.push("send");
        return "job";
      },
      notifyWorker: () => {},
    },
  } as unknown as AppContext;

  const swarm = await makeSwarm("running");
  await ensureSwarmTickWorker(holding);
  assert.deepEqual(calls, ["work"]);

  const stopping = stopSwarmTickWorker(holding);
  // Let the stop reach its offWork and park there.
  await new Promise((resolve) => setImmediate(resolve));
  const enqueueing = enqueueSwarmTick(holding, swarm.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["work", "offWork:start"], "nothing is sent into a queue that is being left");

  releaseOffWork!();
  await stopping;
  await enqueueing;
  assert.deepEqual(
    calls,
    ["work", "offWork:start", "offWork:end", "work", "send"],
    "the tick registered a worker of its own and only then sent the job",
  );
});

/**
 * And the same window from the other side: the worker's own handler
 * asks whether anything is left before it stops, so the question is
 * asked in the turn that does the stopping rather than before it.
 */
test("a worker does not stop while a swarm is still live", async () => {
  const swarm = await makeSwarm("running");
  await enqueueSwarmTick(ctx, swarm.id);
  assert.equal(await stopSwarmTickWorkerIfIdle(ctx), false, "there is still something to reconcile");
  assert.deepEqual(stopped, []);

  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, swarm.id));
  assert.equal(await stopSwarmTickWorkerIfIdle(ctx), true);
  assert.deepEqual(stopped, ["swarm.tick"]);
});
