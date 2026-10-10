import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  agentRuns,
  createDb,
  createPool,
  features,
  gateChecks,
  repositories,
  runEvents,
  runMigrations,
  stages,
  swarmMessages,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { eq } from "drizzle-orm";
import { createApp } from "../app.js";
import type { AppContext } from "../context.js";
import { FakeJobQueue } from "../jobs/index.js";
import { loadEnv } from "../env.js";
import { evaluateFeatureGate } from "./gate-evaluator.js";
import { startFeatureFollowUpRun } from "./rebase-run.js";
import { executeRun } from "./run-executor.js";
import { startAssignedStageAgent } from "./stage-agent.js";
import { NO_REPOSITORIES } from "./start-run.js";
import { tickSwarm } from "./swarm/coordinator.js";

/**
 * A project with no checkout cannot run an agent. The start route says
 * so before a run exists, moving a card onto a stage starts nothing,
 * and a run that was already queued is cancelled rather than failed.
 *
 * The last part is the production failure: executeRun used to throw
 * before it claimed the row, pg-boss retried the job, and every boot
 * requeued the still-queued run. Each attempt was an exception, and
 * the card stayed busy. Failing the run instead made the card say the
 * agent had run and lost.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "no_repositories_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const FEATURE = "55555555-5555-4555-8555-555555555555";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let app: ReturnType<typeof createApp>;
const jobs = new FakeJobQueue();
const board: { type: string; status?: string; runId?: string }[] = [];

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
  await pool.query(`insert into identity.organization (id,name,slug) values ('org-a','A','org-a')`);
  await pool.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1','org-a','P','main')`,
    [PROJECT],
  );
  await pool.query(
    `insert into pipelines (id,project_id,organization_id,name) values ($1,$2,'org-a','Default')`,
    [PIPELINE, PROJECT],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1','org-a','A','fake','fake-1')`,
    [PROFILE],
  );
  await pool.query(
    `insert into stages (id,pipeline_id,organization_id,position,name,slug) values ($1,$2,'org-a',0,'Build','build')`,
    [STAGE, PIPELINE],
  );
  await pool.query(
    `insert into features (id,project_id,organization_id,pipeline_id,title,status,current_stage_id) values ($1,$2,'org-a',$3,'Card','active',$4)`,
    [FEATURE, PROJECT, PIPELINE, STAGE],
  );

  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    userId: "u1",
    driver: { provider: "local-process" },
    jobs,
    bus: {
      emitRunEvent() {},
      emitBoardEvent(event: { type: string; status?: string; runId?: string }) {
        board.push(event);
      },
      emitRunDone() {},
      dropRunDraft() {},
    },
  } as unknown as AppContext;
  app = createApp(ctx);
});

after(async () => {
  await pool?.end();
});

test("a project with no repositories refuses a new run and cancels one already queued", async () => {
  const refused = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: FEATURE, agentProfileId: PROFILE }),
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: NO_REPOSITORIES });
  assert.equal((await db.select({ id: agentRuns.id }).from(agentRuns)).length, 0);

  // Arriving on a stage whose agent would start on its own must not
  // insert a run. The board warns; there is nothing to fail.
  await startAssignedStageAgent(
    ctx,
    { id: FEATURE, projectId: PROJECT },
    { id: STAGE, defaultAgentProfileId: PROFILE },
  );
  assert.equal((await db.select({ id: agentRuns.id }).from(agentRuns)).length, 0);

  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: FEATURE,
      stageId: STAGE,
      agentProfileId: PROFILE,
      prompt: "",
      status: "queued",
      startedBy: "u1",
    })
    .returning();

  jobs.sent.length = 0;
  board.length = 0;
  await assert.doesNotReject(executeRun(ctx, run!.id));

  const [closed] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
  assert.equal(closed?.status, "cancelled");
  assert.equal(closed?.error, null);

  const transcript = await db.select().from(runEvents).where(eq(runEvents.runId, run!.id));
  assert.equal(transcript.length, 0);

  assert.deepEqual(
    board.filter((event) => event.type === "run_updated").map((event) => event.status),
    ["cancelled"],
  );
  // Cancelling settles the card. The gate is what would have been
  // skipped, and a second delivery of the same job must not settle again.
  assert.deepEqual(jobs.sent, [
    { queue: "gate.evaluate", data: { featureId: FEATURE }, opts: { coalesceKey: FEATURE } },
  ]);

  // A duplicate job, the shape a retry or a boot requeue would deliver,
  // finds the run already closed and writes nothing further.
  await executeRun(ctx, run!.id);
  const again = await db.select().from(runEvents).where(eq(runEvents.runId, run!.id));
  assert.equal(again.length, 0);
  assert.deepEqual(jobs.sent, [
    { queue: "gate.evaluate", data: { featureId: FEATURE }, opts: { coalesceKey: FEATURE } },
  ]);

  const quick = await app.request(`/api/features/${FEATURE}/quick-run?cli=claude-code`, { method: "POST" });
  assert.equal(quick.status, 409, await quick.clone().text());
  assert.deepEqual(await quick.json(), { error: NO_REPOSITORIES });

  const message = await app.request(`/api/features/${FEATURE}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "please continue" }),
  });
  assert.equal(message.status, 409);
  assert.deepEqual(await message.json(), { error: NO_REPOSITORIES });

  await db.update(agentRuns).set({ cliSessionId: "session-1" }).where(eq(agentRuns.id, run!.id));
  const resumed = await app.request(`/api/runs/${run!.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "also handle the empty case" }),
  });
  assert.equal(resumed.status, 409);
  assert.deepEqual(await resumed.json(), { error: NO_REPOSITORIES });

  await db.update(features).set({ branchName: "card" }).where(eq(features.id, FEATURE));
  const followUp = await startFeatureFollowUpRun(
    ctx,
    db,
    { id: FEATURE, projectId: PROJECT, branchName: "card", status: "active", currentStageId: STAGE },
    "rebase onto main",
    "u1",
    "rebase",
  );
  assert.deepEqual(followUp, { ok: false, status: 409, error: NO_REPOSITORIES });

  const swarmCreate = await app.request("/api/swarms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT, title: "No checkout" }),
  });
  assert.equal(swarmCreate.status, 409, await swarmCreate.clone().text());
  assert.deepEqual(await swarmCreate.json(), { error: NO_REPOSITORIES });

  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug: "no-checkout",
      title: "No checkout",
      plannerProfileId: PROFILE,
      workerProfileId: PROFILE,
      workerIsolation: "worktree",
      status: "planning",
      startedBy: "u1",
    })
    .returning();
  await db.insert(agentRuns).values({
    type: "swarm",
    swarmId: swarm!.id,
    role: "planner",
    agentProfileId: PROFILE,
    prompt: "",
    status: "failed",
    startedBy: "u1",
  });
  const retry = await app.request(`/api/swarms/${swarm!.id}/planner/retry`, { method: "POST" });
  assert.equal(retry.status, 409, await retry.clone().text());
  assert.deepEqual(await retry.json(), { error: NO_REPOSITORIES });

  // A tick still records a worker that was cancelled, and does not
  // start the planner a queued message would otherwise wake.
  const [worker] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm!.id,
      role: "worker",
      agentProfileId: PROFILE,
      prompt: "",
      status: "cancelled",
      startedBy: "u1",
    })
    .returning();
  await db.insert(swarmTasks).values({
    swarmId: swarm!.id,
    title: "Stopped leaf",
    nodeType: "leaf",
    status: "working",
    assignedRunId: worker!.id,
  });
  const [pendingMessage] = await db
    .insert(swarmMessages)
    .values({ swarmId: swarm!.id, text: "change the plan", userId: "u1", status: "queued" })
    .returning();
  const ticked = await tickSwarm(ctx, swarm!.id);
  assert.equal(ticked?.plannerRunId, null);
  assert.deepEqual(ticked?.workerRunIds, []);
  assert.deepEqual(ticked?.resolverRunIds, []);
  const [leaf] = await db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, swarm!.id));
  assert.equal(leaf?.status, "failed");
  const [stillQueued] = await db.select().from(swarmMessages).where(eq(swarmMessages.id, pendingMessage!.id));
  assert.equal(stillQueued?.status, "queued");
  const planners = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.role, "planner"));
  assert.equal(planners.length, 1);

  await db
    .update(stages)
    .set({ gateType: "auto", gateCriteria: [{ type: "agent_judge", agentProfileId: PROFILE }] })
    .where(eq(stages.id, STAGE));
  const runsBeforeJudge = await db.select({ id: agentRuns.id }).from(agentRuns);
  await evaluateFeatureGate(ctx, FEATURE);
  const runsAfterJudge = await db.select({ id: agentRuns.id }).from(agentRuns);
  assert.equal(runsAfterJudge.length, runsBeforeJudge.length);
  const [judgment] = await db.select().from(gateChecks).where(eq(gateChecks.featureId, FEATURE));
  assert.equal(judgment?.status, "pending");
  assert.equal((judgment?.detail as { message?: string } | null)?.message, NO_REPOSITORIES);

  assert.deepEqual(jobs.sent, [
    { queue: "gate.evaluate", data: { featureId: FEATURE }, opts: { coalesceKey: FEATURE } },
  ]);

  await db.insert(repositories).values({
    projectId: PROJECT,
    name: "app",
    localPath: "/tmp/app",
    position: 0,
  });
  jobs.sent.length = 0;
  const started = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: FEATURE, agentProfileId: PROFILE }),
  });
  assert.equal(started.status, 201, await started.clone().text());
  const body = (await started.json()) as { id: string; status: string };
  assert.equal(body.status, "queued");
  assert.deepEqual(jobs.sent, [{ queue: "run.execute", data: { runId: body.id } }]);
});

test("linking a PR still queues a gate evaluation for the card", async () => {
  jobs.sent.length = 0;
  const linked = await app.request(`/api/features/${FEATURE}/link-pr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prNumber: 7 }),
  });
  assert.equal(linked.status, 200, await linked.clone().text());
  const again = await app.request(`/api/features/${FEATURE}/link-pr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prNumber: 8 }),
  });
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual(jobs.sent, [
    { queue: "gate.evaluate", data: { featureId: FEATURE }, opts: { coalesceKey: FEATURE } },
    { queue: "gate.evaluate", data: { featureId: FEATURE }, opts: { coalesceKey: FEATURE } },
  ]);
});
