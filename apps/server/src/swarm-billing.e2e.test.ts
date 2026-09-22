import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  organization,
  projects,
  runMigrations,
  swarmTasks,
  swarmTemplates,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext, type Entitlements } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { createFeatureFlags } from "./feature-flags.js";
import { markCancelled } from "./orchestrator/run-executor.js";
import { tickSwarm } from "./orchestrator/swarm/coordinator.js";

/**
 * The contract between swarms and whatever bills for them.
 *
 * The open source server knows nothing about plans: everything
 * commercial reaches it through the optional Entitlements methods, and
 * this suite is the only place that says what those methods are
 * promised. A cloud module is written against this contract, so a
 * change here that nobody notices is a change that breaks billing in a
 * repository this one cannot see.
 *
 * Four promises, and each has been broken at least once in this
 * product's short life:
 *
 * 1. canUseSwarms is asked before a swarm is created, and a refusal is
 *    402 with PLAN_LIMIT, which is the code the console turns into an
 *    upgrade prompt rather than an error.
 * 2. canStartRun is asked at the door where a run is actually started,
 *    not only when the swarm was made. A team that had hours an hour
 *    ago may not have them now.
 * 3. A refusal pauses spawning with the reason on the board, and never
 *    kills an agent that is already working.
 * 4. onRunFinished is announced exactly once per run, whichever way the
 *    run ended, because that is what the hours are metered from.
 *
 * It runs with a stub module rather than the real one, which is the
 * point: the stub is the contract written down.
 */
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_billing_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const ORG = "org-with-a-plan";
const ORG_WITHOUT_SWARMS = "org-without-swarms";

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let db: Db;
let projectId: string;
/** The project of the organization whose plan has no swarms at all. */
let refusedProjectId: string;
/** The team's own swarm template, with the team's own agents on it. */
let templateId: string;

/** What the stub was asked, in order, so a missing question is visible. */
let asked: string[];
/** Run ids the deployment was told about, so a double announcement shows. */
let finished: string[];
/**
 * How many times this fake plan will say yes.
 *
 * Counting the permissions rather than metering hours is the strictest
 * reading of the check, and it is the reading that makes a limit
 * visible inside one tick: the spawn loop runs in a transaction, so a
 * module that counted rows would see none of the runs the loop is
 * inserting and would let every leaf through.
 *
 * It costs the creation path one permission it does not spend: the
 * route asks before it writes anything, and the door asks again about
 * the same planner. That is deliberate up there (the refusal used to
 * arrive after the swarm row existed, leaving a team holding a swarm it
 * could not start), and it is harmless to a real module, which answers
 * from metered hours and does not care how often it is asked. The
 * arithmetic below counts both.
 */
let runLimit: number;
/** Permissions this fake plan has given out, reset per test. */
let permitted: number;

const entitlements: Entitlements = {
  async canAddMember() {
    return null;
  },
  async canActivateFeature() {
    return null;
  },
  async canUseSwarms(organizationId: string) {
    asked.push(`canUseSwarms:${organizationId}`);
    return organizationId === ORG_WITHOUT_SWARMS
      ? { reason: "Swarms are not on the Starter plan. Upgrading turns them on for this team." }
      : null;
  },
  async canStartRun(organizationId: string) {
    asked.push(`canStartRun:${organizationId}`);
    if (permitted >= runLimit) {
      return { reason: "This team has used the agent hours on its plan for this period." };
    }
    permitted += 1;
    return null;
  },
  async onRunFinished(runId: string) {
    finished.push(runId);
  },
};

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-swarm-billing-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  db = createDb(pool);
  const userId = await ensureLocalUser(db);

  ctx = {
    env,
    db,
    pool,
    boss: {
      send: async () => "job",
      work: async () => "worker",
      offWork: async () => {},
      notifyWorker: () => {},
      createQueue: async () => {},
      schedule: async () => {},
      unschedule: async () => {},
    } as unknown as AppContext["boss"],
    bus: new EventBus(),
    driver: new LocalProcessDriver(),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
    featureFlags: createFeatureFlags(env),
    entitlements,
  };
  app = createApp(ctx);

  /*
   * Two organizations on one deployment, because the contract is about
   * telling them apart: a module that refused everybody, or nobody,
   * would pass a suite with only one.
   */
  await db.insert(organization).values([
    { id: ORG, name: "Team with swarms", slug: "team-with-swarms", createdAt: new Date() },
    { id: ORG_WITHOUT_SWARMS, name: "Team without", slug: "team-without", createdAt: new Date() },
  ]);
  const [project] = await db
    .insert(projects)
    .values({ ownerId: userId, organizationId: ORG, name: "Swarms", defaultBranch: "main" })
    .returning();
  projectId = project!.id;
  const [refused] = await db
    .insert(projects)
    .values({ ownerId: userId, organizationId: ORG_WITHOUT_SWARMS, name: "No swarms", defaultBranch: "main" })
    .returning();
  refusedProjectId = refused!.id;

  /*
   * The team's agents and its template carry the team, the way a
   * hosted deployment's do. It is not decoration: the run tenant
   * trigger refuses a run whose swarm and whose agent belong to
   * different organizations, so a template of nobody's on a project of
   * somebody's would not start a single agent.
   */
  const [planner] = await db
    .insert(agentProfiles)
    .values({ ownerId: userId, organizationId: ORG, name: "Team planner", cli: "fake", model: "fake-1" })
    .returning();
  const [worker] = await db
    .insert(agentProfiles)
    .values({ ownerId: userId, organizationId: ORG, name: "Team worker", cli: "fake", model: "fake-1" })
    .returning();
  const [template] = await db
    .insert(swarmTemplates)
    .values({
      ownerId: userId,
      organizationId: ORG,
      name: "Team template",
      plannerProfileId: planner!.id,
      workerProfileId: worker!.id,
      workerIsolation: "worktree",
      maxWorkers: 4,
    })
    .returning();
  templateId = template!.id;
});

after(async () => {
  await ctx.pool.end();
});

beforeEach(async () => {
  await db.delete(swarms);
  ctx.running.clear();
  asked = [];
  finished = [];
  runLimit = 100;
  permitted = 0;
});

const post = (path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function createSwarm(project = projectId) {
  return await post("/api/swarms", {
    projectId: project,
    title: "Rewrite checkout",
    goal: "make it work",
    templateId,
  });
}

/* ---------------------------------------------------------------- */

test("a team whose plan has no swarms is refused at creation, with the upgrade code", async () => {
  const res = await createSwarm(refusedProjectId);
  assert.equal(res.status, 402, await res.clone().text());
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "PLAN_LIMIT", "the console turns this into an upgrade prompt, not an error");
  assert.match(body.error, /Upgrading/, "and the sentence says what to do about it");
  assert.ok(asked.includes(`canUseSwarms:${ORG_WITHOUT_SWARMS}`), "asked about the team whose project it is");

  const [none] = await db.select().from(swarms);
  assert.equal(none, undefined, "and nothing was written for a swarm that was refused");
});

test("a team whose plan has swarms is asked, and allowed", async () => {
  const res = await createSwarm();
  assert.equal(res.status, 201, await res.clone().text());
  assert.ok(asked.includes(`canUseSwarms:${ORG}`));
});

test("a team with no agent hours left cannot create a swarm either", async () => {
  runLimit = 0;
  const res = await createSwarm();
  assert.equal(res.status, 402, await res.clone().text());
  assert.equal((await res.json()).code, "PLAN_LIMIT");
  assert.ok(
    asked.includes(`canStartRun:${ORG}`),
    "the hours are asked about before a swarm is written, not after",
  );
});

/**
 * The promise that matters most, because it is the one a swarm can
 * break all by itself: twenty agents started by one click, each of
 * which has to ask.
 */
test("every spawn asks, and the swarm pauses on the leaf that was refused", async () => {
  /*
   * Four permissions: one the creation route spends on its pre-check,
   * one the planner's own door spends, and two for workers. The third
   * leaf asked is the one that finds the ceiling.
   */
  runLimit = 4;
  const created = await createSwarm();
  assert.equal(created.status, 201, await created.clone().text());
  const swarm = (await created.json()) as { id: string; plannerRunId: string };

  // The planner's run is over; the plan it wrote is four leaves.
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, swarm.plannerRunId));
  const leaves = [];
  for (let n = 0; n < 4; n += 1) {
    const [leaf] = await db
      .insert(swarmTasks)
      .values({ swarmId: swarm.id, title: `Leaf ${n}`, status: "assigned", position: n })
      .returning();
    leaves.push(leaf!);
  }
  await db.update(swarms).set({ status: "running" }).where(eq(swarms.id, swarm.id));

  asked = [];
  const result = await tickSwarm(ctx, swarm.id);
  assert.ok(result);
  assert.equal(result.workerRunIds.length, 2, "two runs left on the plan, so two agents");
  assert.equal(
    asked.filter((question) => question.startsWith("canStartRun")).length,
    3,
    "and the third leaf asked too, which is how the swarm found out",
  );
  assert.ok(result.spawnRefusal, "the refusal is what stopped the loop");

  const third = (await db.select().from(swarmTasks).where(eq(swarmTasks.id, leaves[2]!.id)))[0]!;
  assert.equal(third.status, "assigned", "a refused leaf keeps its place rather than failing");
  assert.equal(third.attention, "plan_limit", "and the board says which ceiling it is waiting on");
  assert.match(
    String((third.flags as { spawnRefusal?: string }).spawnRefusal),
    /agent hours/,
    "in the deployment's own words",
  );

  const fourth = (await db.select().from(swarmTasks).where(eq(swarmTasks.id, leaves[3]!.id)))[0]!;
  assert.equal(fourth.attention, null, "the leaf behind it is not asked about, and not marked");

  /*
   * Nothing running is killed: the two agents that started are still
   * going, which is why the swarm is not paused yet. It pauses when
   * they have finished and nothing new can start.
   */
  assert.equal((await db.select().from(swarms).where(eq(swarms.id, swarm.id)))[0]!.status, "blocked");
  for (const runId of result.workerRunIds) {
    await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, runId));
  }
  await tickSwarm(ctx, swarm.id);
  const paused = (await db.select().from(swarms).where(eq(swarms.id, swarm.id)))[0]!;
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedReason, "plan_limit", "so the header can say why, and the banner can say what to do");

  // And when the hours come back, the next tick starts the rest.
  runLimit = 100;
  const resumed = await tickSwarm(ctx, swarm.id);
  assert.equal(resumed?.workerRunIds.length, 2, "the two leaves that were waiting start, without anybody asking");
  const back = (await db.select().from(swarms).where(eq(swarms.id, swarm.id)))[0]!;
  assert.notEqual(back.status, "paused", "and the swarm is no longer waiting on the plan");
  assert.equal(back.pausedReason, null);
  /*
   * It reads as blocked rather than running, and that is right: the two
   * workers from the first pass were marked succeeded above without
   * ever reporting, so their leaves failed and are asking for a person.
   * The ceiling is what this test is about, and the ceiling has lifted.
   */
  assert.equal(back.status, "blocked");
});

/**
 * The hours are metered from this, so once per run and never twice. It
 * is announced through the run executor's single terminal path, which
 * is why cancelling counts: the sandbox ran either way.
 */
test("every swarm run is announced to the deployment exactly once", async () => {
  const created = await createSwarm();
  const swarm = (await created.json()) as { id: string; plannerRunId: string };

  await markCancelled(ctx, swarm.plannerRunId);
  assert.deepEqual(finished, [swarm.plannerRunId], "a cancelled run still spent the time it spent");

  // The compare and set behind the announcement is what makes this
  // once: two loops driving one run during a restart used to announce
  // it twice, which is an hour billed twice.
  await markCancelled(ctx, swarm.plannerRunId);
  assert.deepEqual(finished, [swarm.plannerRunId], "and the second attempt announces nothing");
});

/**
 * The same sentence, in dollars.
 *
 * The hours have always counted a cancelled run, because the sandbox
 * ran either way. The money did not: the ledger hung entirely off the
 * path a run takes when it finishes by itself, so every run a person
 * stopped spent real tokens that were charged to nobody.
 *
 * That is the worst shape this bug could take, because the two new
 * controls that stop a run are Retry and Cancel, and Retry is the
 * button somebody presses when a worker is going badly. Ten retries of
 * a thirty minute worker moved the swarm's spend by nothing at all,
 * and a budget that cannot see what it spent is a budget that cannot
 * refuse.
 */
test("a run somebody stopped is charged for what it spent", async () => {
  const created = await createSwarm();
  const swarm = (await created.json()) as { id: string; plannerRunId: string };

  await markCancelled(ctx, swarm.plannerRunId);

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, swarm.plannerRunId));
  assert.equal(run!.status, "cancelled");
  /*
   * The assumed tier, which is exactly what it is for: a run that was
   * stopped printed no cost and no tokens, and zero is the one answer
   * that is certainly wrong, because the agent ran.
   */
  assert.equal(run!.costTier, "assumed", "a stopped run reports nothing, so its figure is a stand in");
  assert.ok(Number(run!.costUsd) > 0, "and it is not free");

  const [charged] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  assert.equal(
    Number(charged!.spentAssumedUsd),
    Number(run!.costUsd),
    "and the swarm's own ledger is what the budget reads",
  );

  // Once, like the announcement: the same compare and set guards both.
  await markCancelled(ctx, swarm.plannerRunId);
  const [again] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  assert.equal(Number(again!.spentAssumedUsd), Number(run!.costUsd), "a second stop charges nothing again");
});

/**
 * Local mode has no organization, so none of this is asked at all. The
 * same code, and every question skipped by construction rather than by
 * a branch somebody has to remember to write.
 */
test("a project with no organization asks the plan nothing", async () => {
  const [personal] = await db
    .insert(projects)
    .values({ ownerId: ctx.userId!, organizationId: null, name: "Personal", defaultBranch: "main" })
    .returning();

  asked = [];
  const res = await post("/api/swarms", { projectId: personal!.id, title: "Mine", goal: "just me" });
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual(asked, [], "nothing to charge, and nobody to charge it to");
});
