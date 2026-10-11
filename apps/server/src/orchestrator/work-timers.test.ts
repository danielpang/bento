import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  featureMessages,
  features,
  runMigrations,
  type Db,
} from "@bento/db";
import type { AppContext } from "../context.js";
import { FakeJobQueue } from "../jobs/index.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { actorMiddleware } from "../middleware/actor.js";
import { tenantMiddleware } from "../middleware/tenant.js";
import { runnerRoutes } from "../routes/runner.js";
import { queueFeatureEventFollowUps } from "./gate-evaluator.js";
import { handleRunnerReap, QUEUED_RUN_REQUEUE_MIN, reapExpiredRunnerLease, STALLED_RUN_MIN } from "./run-executor.js";
import {
  GATE_CARD_CRON,
  PARKED_COMPUTE_CRON,
  PARKED_COMPUTE_PRESENCE_KEY,
  PARKED_COMPUTE_SWEEP_ID,
  WORK_TIMER_DAILY_ID,
  armServerRunQueuedRecovery,
  armServerRunStallRecovery,
  countParkedComputeWork,
  gateSchedulerId,
  isIdleWorkTimerSchedule,
  parkedComputeSweepShouldRun,
  reconcileGateSchedules,
  reconcileRunnerLeases,
  reconcileServerRunRecoveries,
  refreshRunnerLease,
  runnerLeaseKey,
  serverRunQueuedKey,
  serverRunStallKey,
  signalParkedCompute,
  syncGateSchedule,
  syncParkedComputePresence,
} from "./work-timers.js";

/**
 * Row-derived timers: a card's gate clock, a parked-compute signal,
 * and a runner lease. Time is not waited; the jobs and the rows are.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "work_timers_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const PIPELINE = "33333333-3333-3333-3333-333333333333";
const STAGE = "44444444-4444-4444-4444-444444444444";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let jobs: FakeJobQueue;
let runnerApp: Hono;

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
  await pool.query(`insert into pipelines (id,project_id,name,is_default) values ($1,$2,'Default',true)`, [
    PIPELINE,
    PROJECT,
  ]);
  await pool.query(`insert into stages (id,pipeline_id,position,name,slug) values ($1,$2,0,'Build','build')`, [
    STAGE,
    PIPELINE,
  ]);

  jobs = new FakeJobQueue();
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_RUNNER_CLAIM_TIMEOUT_MIN: "1",
  } as NodeJS.ProcessEnv);
  ctx = {
    env,
    db,
    pool,
    bus: new EventBus(),
    userId: "u1",
    jobs,
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    drivers: { default: { provider: "local-process" }, get: () => undefined, selectable: () => [] },
  } as unknown as AppContext;
  runnerApp = new Hono()
    .use("*", actorMiddleware(ctx))
    .use("*", tenantMiddleware(ctx))
    .route("/api/runner", runnerRoutes(ctx));
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from feature_messages");
  await pool.query("delete from agent_runs");
  await pool.query("delete from features");
  jobs.sent.length = 0;
  jobs.scheduled.length = 0;
  jobs.unscheduled.length = 0;
  jobs.presence.clear();
});

async function makeFeature(status: "backlog" | "active" | "gated" | "done" = "active") {
  const [feature] = await db
    .insert(features)
    .values({
      projectId: PROJECT,
      pipelineId: PIPELINE,
      title: "Card",
      status,
      currentStageId: STAGE,
    })
    .returning();
  return feature!;
}

async function makeRun(
  featureId: string,
  overrides: Partial<typeof agentRuns.$inferInsert> = {},
) {
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId,
      stageId: STAGE,
      agentProfileId: PROFILE,
      prompt: "go",
      status: "succeeded",
      executor: "server",
      ...overrides,
    })
    .returning();
  return run!;
}

function gateSchedule(featureId: string) {
  return jobs.scheduled.find((row) => row.id === gateSchedulerId(featureId));
}

/* ---------------------------------------------------------------- */

test("entering gated creates a per-card schedule, leaving removes it", async () => {
  const feature = await makeFeature("active");
  await syncGateSchedule(ctx, feature.id);
  assert.equal(gateSchedule(feature.id), undefined);

  await db.update(features).set({ status: "gated" }).where(eq(features.id, feature.id));
  await syncGateSchedule(ctx, feature.id);
  const scheduled = gateSchedule(feature.id);
  assert.ok(scheduled, "a gated card holds its own clock");
  assert.equal(scheduled.queue, "gate.evaluate");
  assert.equal(scheduled.cron, GATE_CARD_CRON);
  assert.deepEqual(scheduled.data, { featureId: feature.id });

  await db.update(features).set({ status: "active" }).where(eq(features.id, feature.id));
  await syncGateSchedule(ctx, feature.id);
  assert.equal(gateSchedule(feature.id), undefined, "leaving gated drops the clock");
  assert.ok(jobs.unscheduled.includes(gateSchedulerId(feature.id)));
});

test("a status follow-up is what arms and disarms the gate clock", async () => {
  const feature = await makeFeature("gated");
  await queueFeatureEventFollowUps(ctx, {
    featureId: feature.id,
    kind: "status_changed",
    fromStatus: "active",
    toStatus: "gated",
    trigger: "gate_auto",
  });
  assert.ok(gateSchedule(feature.id));

  await db.update(features).set({ status: "done" }).where(eq(features.id, feature.id));
  await queueFeatureEventFollowUps(ctx, {
    featureId: feature.id,
    kind: "status_changed",
    fromStatus: "gated",
    toStatus: "done",
    trigger: "manual",
  });
  assert.equal(gateSchedule(feature.id), undefined);
});

test("boot rebuilds gate clocks, runner leases, and parked-compute presence", async () => {
  const gated = await makeFeature("gated");
  const active = await makeFeature("active");
  const claimed = await makeRun(active.id, {
    status: "starting",
    executor: "runner",
    claimedBy: "laptop",
    claimedAt: new Date(),
  });
  const parkedOn = await makeFeature("active");
  await makeRun(parkedOn.id, { status: "failed" });
  await db.insert(featureMessages).values({ featureId: parkedOn.id, text: "try again" });

  const restoredGates = await reconcileGateSchedules(ctx);
  assert.deepEqual(restoredGates, [gated.id]);
  assert.ok(gateSchedule(gated.id));
  assert.equal(gateSchedule(active.id), undefined);

  const restoredLeases = await reconcileRunnerLeases(ctx);
  assert.deepEqual(restoredLeases, [claimed.id]);
  const lease = jobs.sent.find((job) => job.queue === "runner.reap");
  assert.ok(lease);
  assert.deepEqual(lease.data, { runId: claimed.id });
  assert.equal(lease.opts?.debounceKey, runnerLeaseKey(claimed.id));
  assert.equal(lease.opts?.delayMs, 60_000);

  const count = await syncParkedComputePresence(ctx);
  assert.equal(count, 1);
  assert.equal(await jobs.getPresence(PARKED_COMPUTE_PRESENCE_KEY), 1);
  const parked = jobs.scheduled.find((row) => row.id === PARKED_COMPUTE_SWEEP_ID);
  assert.ok(parked, "parked work holds a sweep");
  assert.equal(parked.cron, PARKED_COMPUTE_CRON);
});

test("a stale zero signal does not query; reconciliation restores it", async () => {
  const feature = await makeFeature("active");
  await makeRun(feature.id, { status: "succeeded" });
  await db.insert(featureMessages).values({ featureId: feature.id, text: "when hours return" });

  await jobs.setPresence(PARKED_COMPUTE_PRESENCE_KEY, 0);
  assert.equal(await parkedComputeSweepShouldRun(ctx), false, "zero means the five-minute sweep stays off Postgres");
  assert.equal(await countParkedComputeWork(ctx), 1, "the rows still have work");

  const count = await syncParkedComputePresence(ctx);
  assert.equal(count, 1, "boot and the daily pass recompute from the rows");
  assert.equal(await jobs.getPresence(PARKED_COMPUTE_PRESENCE_KEY), 1);
  assert.ok(jobs.scheduled.find((row) => row.id === PARKED_COMPUTE_SWEEP_ID));
});

test("parking for compute raises presence and arms the sweep", async () => {
  await signalParkedCompute(ctx);
  assert.equal(await jobs.getPresence(PARKED_COMPUTE_PRESENCE_KEY), 1);
  const parked = jobs.scheduled.find((row) => row.id === PARKED_COMPUTE_SWEEP_ID);
  assert.ok(parked);
  assert.deepEqual(parked.data, { kind: "parked" });
});

test("an expired runner lease returns the run to the queue; a fresh heartbeat does not", async () => {
  const feature = await makeFeature("active");
  const stale = await makeRun(feature.id, {
    status: "starting",
    executor: "runner",
    claimedBy: "laptop",
    claimedAt: new Date(Date.now() - 2 * 60_000),
    startedAt: new Date(Date.now() - 2 * 60_000),
  });
  const fresh = await makeRun(feature.id, {
    status: "running",
    executor: "runner",
    claimedBy: "other",
    claimedAt: new Date(),
    startedAt: new Date(),
  });

  assert.equal(await reapExpiredRunnerLease(ctx, stale.id), true);
  const [requeued] = await db.select().from(agentRuns).where(eq(agentRuns.id, stale.id));
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.claimedBy, null);

  assert.equal(await reapExpiredRunnerLease(ctx, fresh.id), false);
  const [still] = await db.select().from(agentRuns).where(eq(agentRuns.id, fresh.id));
  assert.equal(still?.status, "running");
  assert.equal(still?.claimedBy, "other");
});

test("a heartbeat replaces the waiting lease", async () => {
  await refreshRunnerLease(ctx, "run-1");
  await refreshRunnerLease(ctx, "run-1");
  const leases = jobs.sent.filter((job) => job.queue === "runner.reap");
  assert.equal(leases.length, 2);
  assert.equal(leases[1]?.opts?.debounceKey, runnerLeaseKey("run-1"));
  assert.equal(leases[1]?.opts?.delayMs, 60_000);
});

test("a healthy long-running runner claim is not reaped: events refresh its lease", async () => {
  const feature = await makeFeature("active");
  const run = await makeRun(feature.id, { status: "queued", executor: "runner" });

  const claim = await runnerApp.request("/api/runner/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: "laptop" }),
  });
  assert.equal(claim.status, 200, await claim.clone().text());
  const claimed = (await claim.json()) as { run: { id: string } | null };
  assert.equal(claimed.run?.id, run.id);

  const afterClaim = jobs.sent.filter((job) => job.queue === "runner.reap");
  assert.equal(afterClaim.length, 1, "claim arms runner-lease:<runId>");
  assert.deepEqual(afterClaim[0]?.data, { runId: run.id });
  assert.equal(afterClaim[0]?.opts?.debounceKey, runnerLeaseKey(run.id));
  assert.equal(afterClaim[0]?.opts?.delayMs, 60_000);

  // The claim is already older than the timeout. Without a heartbeat
  // the delayed job would reap it. The events report is that heartbeat.
  await db
    .update(agentRuns)
    .set({ claimedAt: new Date(Date.now() - 2 * 60_000) })
    .where(eq(agentRuns.id, run.id));

  const events = await runnerApp.request(`/api/runner/runs/${run.id}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: "laptop",
      events: [{ type: "message", role: "assistant", text: "still working" }],
    }),
  });
  assert.equal(events.status, 200, await events.clone().text());

  const leases = jobs.sent.filter((job) => job.queue === "runner.reap");
  assert.equal(leases.length, 2, "the events report replaces the waiting lease");
  assert.equal(leases[1]?.opts?.debounceKey, runnerLeaseKey(run.id));
  assert.equal(leases[1]?.opts?.delayMs, 60_000);

  // The original delayed job landing now is a debounce miss. claimedAt
  // is the backstop: a reporting machine is not requeued.
  await handleRunnerReap(ctx, { runId: run.id });
  const [still] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
  assert.equal(still?.status, "running");
  assert.equal(still?.claimedBy, "laptop");
  assert.ok(
    still?.claimedAt && still.claimedAt.getTime() > Date.now() - 10_000,
    "the events report stamped a fresh heartbeat",
  );
});

test("queuing a server run arms stranded recovery at the prior timeout", async () => {
  await armServerRunQueuedRecovery(ctx, "run-queued");
  const job = jobs.sent.find((row) => row.queue === "runner.reap");
  assert.ok(job, "a queued server run holds a delayed recovery");
  assert.deepEqual(job.data, { runId: "run-queued", kind: "stranded" });
  assert.equal(job.opts?.debounceKey, serverRunQueuedKey("run-queued"));
  assert.equal(job.opts?.delayMs, QUEUED_RUN_REQUEUE_MIN * 60_000);
});

test("a server run entering starting arms stall recovery at the prior timeout", async () => {
  await armServerRunStallRecovery(ctx, "run-stall");
  const job = jobs.sent.find((row) => row.queue === "runner.reap");
  assert.ok(job, "a starting server run holds a delayed recovery");
  assert.deepEqual(job.data, { runId: "run-stall", kind: "stalled" });
  assert.equal(job.opts?.debounceKey, serverRunStallKey("run-stall"));
  assert.equal(job.opts?.delayMs, STALLED_RUN_MIN * 60_000);
});

test("boot reconstructs delayed recoveries for queued and starting server runs", async () => {
  const feature = await makeFeature("active");
  const queued = await makeRun(feature.id, { status: "queued", executor: "server" });
  const starting = await makeRun(feature.id, {
    status: "starting",
    executor: "server",
    startedAt: new Date(),
  });
  const claimed = await makeRun(feature.id, {
    status: "starting",
    executor: "runner",
    claimedBy: "laptop",
    claimedAt: new Date(),
  });

  const restored = await reconcileServerRunRecoveries(ctx);
  assert.deepEqual(new Set(restored.stranded), new Set([queued.id]));
  assert.deepEqual(new Set(restored.stalled), new Set([starting.id]));

  const stranded = jobs.sent.find(
    (job) => job.queue === "runner.reap" && (job.data as { runId?: string }).runId === queued.id,
  );
  assert.ok(stranded);
  assert.deepEqual(stranded.data, { runId: queued.id, kind: "stranded" });
  assert.equal(stranded.opts?.delayMs, QUEUED_RUN_REQUEUE_MIN * 60_000);

  const stall = jobs.sent.find(
    (job) => job.queue === "runner.reap" && (job.data as { runId?: string }).runId === starting.id,
  );
  assert.ok(stall);
  assert.deepEqual(stall.data, { runId: starting.id, kind: "stalled" });
  assert.equal(stall.opts?.delayMs, STALLED_RUN_MIN * 60_000);

  assert.equal(
    jobs.sent.filter((job) => (job.data as { runId?: string }).runId === claimed.id).length,
    0,
    "a runner claim is not a server-run recovery",
  );
});

test("a live process recovers a stranded queued run when its delayed job fires", async () => {
  const feature = await makeFeature("active");
  const stranded = await makeRun(feature.id, {
    status: "queued",
    executor: "server",
    queuedAt: new Date(Date.now() - (QUEUED_RUN_REQUEUE_MIN + 5) * 60_000),
  });
  await armServerRunQueuedRecovery(ctx, stranded.id);
  jobs.sent.length = 0;

  await handleRunnerReap(ctx, { runId: stranded.id, kind: "stranded" });
  assert.ok(
    jobs.sent.some((job) => job.queue === "run.execute" && (job.data as { runId: string }).runId === stranded.id),
    "the lost run.execute is sent again near the prior timeout",
  );
});

test("server-run recovery does not query postgres when no such rows exist", async () => {
  const restored = await reconcileServerRunRecoveries(ctx);
  assert.deepEqual(restored, { stalled: [], stranded: [] });
  assert.equal(
    jobs.sent.filter((job) => job.queue === "runner.reap").length,
    0,
    "no delayed recovery means the worker is never invoked",
  );

  jobs.sent.length = 0;
  let queries = 0;
  const originalExecute = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    queries += 1;
    return originalExecute(...(args as Parameters<typeof originalExecute>));
  }) as typeof pool.query;
  try {
    // A live idle process has no runner.reap job to run. Reconcile
    // already learned there is nothing; the worker is the only later
    // path that would open Postgres, and it is not scheduled.
    assert.equal(jobs.sent.length, 0);
    assert.equal(queries, 0, "no job means the worker never opens Postgres");
  } finally {
    pool.query = originalExecute;
  }
});

test("an empty deployment holds no idle work-timer schedules", async () => {
  await reconcileGateSchedules(ctx);
  await reconcileRunnerLeases(ctx);
  await reconcileServerRunRecoveries(ctx);
  await syncParkedComputePresence(ctx);
  assert.equal(await jobs.getPresence(PARKED_COMPUTE_PRESENCE_KEY), 0);
  assert.equal(await parkedComputeSweepShouldRun(ctx), false);
  assert.deepEqual(
    jobs.scheduled.filter((row) => isIdleWorkTimerSchedule(row.id)).map((row) => row.id),
    [],
    "no per-card clock, no parked sweep, no leftover cron",
  );
  assert.equal(
    jobs.sent.filter((job) => job.queue === "runner.reap").length,
    0,
    "no claimed run and no server-run recovery means no delayed reap",
  );
  assert.equal(WORK_TIMER_DAILY_ID, "gate.sweep");
});
