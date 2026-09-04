import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {
  agentRuns,
  createDb,
  createPool,
  features,
  runMigrations,
  stages,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import type { Analytics, ServerEvent } from "../analytics.js";
import type { AppContext } from "../context.js";
import { captureRunFinished } from "./run-executor.js";

/**
 * What a finished run reports, for both boards.
 *
 * Against a real database because the failure this pins was a join: a
 * run's parent is a card or a swarm, and reading the two through one
 * required join dropped every swarm run silently. A stubbed query
 * builder would have agreed with the broken version.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "run_finished_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const PIPELINE = "33333333-3333-3333-3333-333333333333";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let captured: ServerEvent[];

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
  await pool.query(`insert into pipelines (id,project_id,name) values ($1,$2,'Default')`, [PIPELINE, PROJECT]);
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1','org-a','A','fake','fake-1')`,
    [PROFILE],
  );

  captured = [];
  const analytics: Analytics = {
    capture: (event) => captured.push(event),
    captureException: () => {},
    shutdown: async () => {},
  };
  ctx = { db, pool, analytics } as unknown as AppContext;
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from agent_runs");
  await pool.query("delete from swarms");
  await pool.query("delete from features");
  captured.length = 0;
});

const finished = () => captured.filter((event) => event.event === "agent run finished");

test("a card's run reports what it cost, with its card and its stage", async () => {
  const [stage] = await db
    .insert(stages)
    .values({ pipelineId: PIPELINE, name: "Build", slug: "build", position: 0 })
    .returning();
  const [feature] = await db
    .insert(features)
    .values({ projectId: PROJECT, pipelineId: PIPELINE, stageId: stage!.id, title: "Card" })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId: feature!.id,
      stageId: stage!.id,
      agentProfileId: PROFILE,
      prompt: "",
      status: "succeeded",
      startedBy: "u1",
      costUsd: "1.25",
      numTurns: 7,
      exitCode: 0,
    })
    .returning();

  await captureRunFinished(ctx, run!.id, "succeeded");

  assert.equal(finished().length, 1);
  const event = finished()[0]!;
  assert.equal(event.organizationId, "org-a");
  assert.equal(event.properties?.feature_id, feature!.id);
  assert.equal(event.properties?.project_id, PROJECT);
  assert.equal(event.properties?.cost_usd, 1.25);
  assert.equal(event.properties?.num_turns, 7);
});

test("a swarm's run reports too, with the swarm and the leaf it worked", async () => {
  const [swarm] = await db
    .insert(swarms)
    .values({ projectId: PROJECT, slug: "s1", title: "Swarm", status: "running" })
    .returning();
  const [task] = await db.insert(swarmTasks).values({ swarmId: swarm!.id, title: "Leaf" }).returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm!.id,
      swarmTaskId: task!.id,
      role: "worker",
      agentProfileId: PROFILE,
      prompt: "",
      status: "failed",
      startedBy: "u1",
      costUsd: "0.40",
      numTurns: 3,
      exitCode: 1,
      error: "the worker died",
    })
    .returning();

  await captureRunFinished(ctx, run!.id, "failed");

  // The whole finding: a swarm run has no feature, so an inner join on
  // features reported nothing at all for it.
  assert.equal(finished().length, 1, "a swarm run's finish must be reported");
  const event = finished()[0]!;
  assert.equal(event.organizationId, "org-a", "the team comes off the swarm when there is no card");
  assert.equal(event.properties?.project_id, PROJECT);
  assert.equal(event.properties?.type, "swarm");
  assert.equal(event.properties?.swarm_id, swarm!.id);
  assert.equal(event.properties?.swarm_task_id, task!.id);
  assert.equal(event.properties?.feature_id, null);
  assert.equal(event.properties?.role, "worker");
  assert.equal(event.properties?.cost_usd, 0.4);
  assert.equal(event.properties?.num_turns, 3);
  assert.equal(event.properties?.exit_code, 1);
  assert.equal(event.properties?.error, "the worker died");
});
