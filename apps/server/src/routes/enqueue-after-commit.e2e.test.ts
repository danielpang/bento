import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pg from "pg";
import {
  agentRuns,
  createDb,
  createPool,
  features,
  runMigrations,
  sandboxes,
  slackThreadLinks,
  type Db,
} from "@bento/db";
import type { AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { FakeJobQueue } from "../jobs/index.js";
import { actorMiddleware } from "../middleware/actor.js";
import { tenantMiddleware } from "../middleware/tenant.js";
import { featureRoutes } from "./features.js";
import { runRoutes } from "./runs.js";
import { runnerRoutes } from "./runner.js";

/**
 * The remaining request-path producers, checked in multi mode against
 * a real tenant transaction. A send from inside that transaction is
 * visible to a worker before the row it names is; the worker then
 * finds nothing and acks. Each test watches the send from another
 * connection, the way a worker would.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "enqueue_after_commit_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const PIPELINE = "33333333-3333-4333-8333-333333333333";
const STAGE = "44444444-4444-4444-8444-444444444444";
const FEATURE = "55555555-5555-4555-8555-555555555555";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let app: Hono;
const jobs = new FakeJobQueue();

type SeenSend = { queue: string; visible: number; status: string | null };
const seenAtSend: SeenSend[] = [];

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = createPool(testUrl);
  db = createDb(pool);
  await pool.query(`insert into identity.organization (id,name,slug) values ('org-a','A','org-a')`);
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
  await pool.query(
    `insert into identity.member (id,organization_id,user_id,role) values ('mem-1','org-a','u1','owner')`,
  );
  await pool.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch,executor)
     values ($1,'u1','org-a','P','main','server')`,
    [PROJECT],
  );
  await pool.query(
    `insert into pipelines (id,project_id,organization_id,name) values ($1,$2,'org-a','Default')`,
    [PIPELINE, PROJECT],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model)
     values ($1,'u1','org-a','A','fake','fake-1')`,
    [PROFILE],
  );
  await pool.query(
    `insert into stages (id,pipeline_id,organization_id,position,name,slug,default_agent_profile_id)
     values ($1,$2,'org-a',0,'Build','build',$3)`,
    [STAGE, PIPELINE, PROFILE],
  );
  await pool.query(
    `insert into features (id,project_id,organization_id,pipeline_id,title,status,current_stage_id)
     values ($1,$2,'org-a',$3,'Card','active',$4)`,
    [FEATURE, PROJECT, PIPELINE, STAGE],
  );
  await pool.query(
    `insert into repositories (project_id,organization_id,name,local_path,position)
     values ($1,'org-a','app','/tmp/app',0)`,
    [PROJECT],
  );

  const originalSend = jobs.send.bind(jobs);
  jobs.send = (async (queue, data, opts) => {
    if (queue === "run.execute") {
      const runId = (data as { runId: string }).runId;
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
      seenAtSend.push({ queue, visible: rows.length, status: rows[0]?.status ?? null });
    } else if (queue === "slack.notify") {
      const runId = (data as { runId?: string }).runId;
      const rows = runId ? await db.select().from(agentRuns).where(eq(agentRuns.id, runId)) : [];
      seenAtSend.push({ queue, visible: rows.length, status: rows[0]?.status ?? null });
    } else if (queue === "sandbox.hibernate") {
      const sandboxId = (data as { sandboxId: string }).sandboxId;
      const rows = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId));
      seenAtSend.push({ queue, visible: rows.length, status: rows[0]?.status ?? null });
    } else if (queue === "gate.evaluate") {
      const featureId = (data as { featureId: string }).featureId;
      const rows = await db.select().from(features).where(eq(features.id, featureId));
      seenAtSend.push({ queue, visible: rows.length, status: rows[0]?.status ?? null });
    }
    return originalSend(queue, data, opts);
  }) as typeof jobs.send;

  ctx = {
    env: loadEnv({ BENTO_MODE: "multi", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    userId: "u1",
    auth: {
      api: {
        getSession: async () => ({
          user: { id: "u1" },
          session: { activeOrganizationId: "org-a" },
        }),
      },
    },
    jobs,
    bus: {
      emitRunEvent() {},
      emitBoardEvent() {},
      emitRunDone() {},
      dropRunDraft() {},
    },
    drivers: {
      default: { provider: "local-process" },
      get: (provider: string) =>
        provider === "modal"
          ? { provider: "modal", restore: async () => {} }
          : undefined,
      selectable: () => ["modal"],
    },
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
  } as unknown as AppContext;
  app = new Hono()
    .use("*", actorMiddleware(ctx))
    .use("*", tenantMiddleware(ctx))
    .route("/api/runs", runRoutes(ctx))
    .route("/api/features", featureRoutes(ctx))
    .route("/api/runner", runnerRoutes(ctx));
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from slack_thread_links");
  await pool.query("delete from feature_messages");
  await pool.query("delete from agent_runs");
  await pool.query("delete from sandboxes");
  jobs.sent.length = 0;
  seenAtSend.length = 0;
});

function executeSends() {
  return seenAtSend.filter((row) => row.queue === "run.execute");
}

test("POST /api/runs enqueues the run once after the tenant commit", async () => {
  const res = await app.request("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ featureId: FEATURE, agentProfileId: PROFILE }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { id: string };
  const sends = executeSends();
  assert.equal(sends.length, 1, "enqueueRun must send once");
  assert.equal(sends[0]?.visible, 1, "the run row must be visible to another connection at send");
  assert.deepEqual(
    jobs.sent.filter((job) => job.queue === "run.execute"),
    [{ queue: "run.execute", data: { runId: body.id } }],
  );
});

test("POST /api/runs/:id/resume enqueues the continuation once after commit", async () => {
  const [previous] = await db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: FEATURE,
      stageId: STAGE,
      agentProfileId: PROFILE,
      prompt: "first",
      status: "succeeded",
      executor: "server",
      cliSessionId: "sess-1",
      startedBy: "u1",
    })
    .returning();
  const res = await app.request(`/api/runs/${previous!.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "also the empty case" }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { id: string };
  const sends = executeSends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.visible, 1);
  assert.deepEqual(
    jobs.sent.filter((job) => job.queue === "run.execute"),
    [{ queue: "run.execute", data: { runId: body.id } }],
  );
});

test("POST /api/features/:id/message enqueues the follow-up once after commit", async () => {
  await db.insert(agentRuns).values({
    type: "pipeline",
    featureId: FEATURE,
    stageId: STAGE,
    agentProfileId: PROFILE,
    prompt: "first",
    status: "succeeded",
    executor: "server",
    cliSessionId: "sess-1",
    startedBy: "u1",
  });
  const res = await app.request(`/api/features/${FEATURE}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "try the empty case" }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { run?: { id: string } };
  const sends = executeSends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.visible, 1);
  assert.ok(body.run?.id);
  assert.deepEqual(
    jobs.sent.filter((job) => job.queue === "run.execute"),
    [{ queue: "run.execute", data: { runId: body.run.id } }],
  );
});

test("POST /api/features/:id/quick-run enqueues the run once after commit", async () => {
  const res = await app.request(`/api/features/${FEATURE}/quick-run?cli=fake`, { method: "POST" });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { id: string };
  const sends = executeSends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.visible, 1);
  assert.deepEqual(
    jobs.sent.filter((job) => job.queue === "run.execute"),
    [{ queue: "run.execute", data: { runId: body.id } }],
  );
});

test("a runner finish queues Slack once after the status commit", async () => {
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: FEATURE,
      stageId: STAGE,
      agentProfileId: PROFILE,
      prompt: "go",
      status: "running",
      executor: "runner",
      claimedBy: "laptop",
      claimedAt: new Date(),
      startedAt: new Date(),
      startedBy: "u1",
    })
    .returning();
  await db.insert(slackThreadLinks).values({
    organizationId: "org-a",
    featureId: FEATURE,
    slackTeamId: "T1",
    slackChannelId: "C1",
    slackThreadTs: "1.2",
    slackUserId: "U1",
  });

  const res = await app.request(`/api/runner/runs/${run!.id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: "laptop", ok: true }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const slack = seenAtSend.filter((row) => row.queue === "slack.notify");
  assert.equal(slack.length, 1, "queueRunFinishedSlack must send once");
  assert.equal(slack[0]?.visible, 1);
  assert.equal(slack[0]?.status, "succeeded", "the worker must see the committed terminal status");

  const gates = seenAtSend.filter((row) => row.queue === "gate.evaluate");
  assert.equal(gates.length, 1, "the already-deferred gate.evaluate path stays intact");
  assert.equal(gates[0]?.visible, 1);
});

test("rolling back a Modal sandbox arms hibernation once after the row commit", async () => {
  const [sandbox] = await db
    .insert(sandboxes)
    .values({
      projectId: PROJECT,
      organizationId: "org-a",
      featureId: FEATURE,
      provider: "modal",
      externalId: `bento-${FEATURE}`,
      status: "hibernated",
      workdir: "/workspace",
    })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: FEATURE,
      stageId: STAGE,
      agentProfileId: PROFILE,
      prompt: "done",
      status: "succeeded",
      executor: "server",
      checkpointId: "snap-1",
      sandboxId: sandbox!.id,
      startedBy: "u1",
    })
    .returning();

  const res = await app.request(`/api/runs/${run!.id}/rollback`, { method: "POST" });
  assert.equal(res.status, 200, await res.clone().text());

  const hibernate = seenAtSend.filter((row) => row.queue === "sandbox.hibernate");
  assert.equal(hibernate.length, 1, "armModalHibernation must send once");
  assert.equal(hibernate[0]?.visible, 1);
  assert.equal(hibernate[0]?.status, "ready", "the hibernate job must see the committed ready row");
  const [awake] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandbox!.id));
  assert.equal(awake?.status, "ready");
});
