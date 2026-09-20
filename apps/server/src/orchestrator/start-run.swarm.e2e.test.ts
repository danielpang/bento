import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runMigrations,
  swarmLandings,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import type { Entitlements } from "../context.js";
import { startRunIfIdle } from "./start-run.js";

/**
 * The swarm half of the one door every run start goes through.
 *
 * A swarm is many agents at once on purpose, so "one card, one agent"
 * is the wrong rule and each role gets its own. These are the rules,
 * one test each, against a real database: the refusals are decided
 * under a row lock and by counting rows, and neither survives being
 * stubbed.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_start_run_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const LOCAL_PROJECT = "11111111-1111-1111-1111-111111111111";
const TEAM_PROJECT = "22222222-2222-2222-2222-222222222222";
const LOCAL_PROFILE = "33333333-3333-3333-3333-333333333333";
const TEAM_PROFILE = "44444444-4444-4444-4444-444444444444";

let pool: ReturnType<typeof createPool>;
let db: Db;

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
    `insert into projects (id,owner_id,organization_id,name,default_branch) values
      ($1,'u1',null,'local','main'), ($2,'u1','org-a','team','main')`,
    [LOCAL_PROJECT, TEAM_PROJECT],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values
      ($1,'u1',null,'local agent','fake','fake-1'), ($2,'u1','org-a','team agent','fake','fake-1')`,
    [LOCAL_PROFILE, TEAM_PROFILE],
  );
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from swarms");
});

async function makeSwarm(overrides: Partial<typeof swarms.$inferInsert> = {}) {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: LOCAL_PROJECT,
      slug: `s-${Math.random().toString(36).slice(2, 8)}`,
      title: "Swarm",
      status: "running",
      maxWorkers: 2,
      ...overrides,
    })
    .returning();
  return swarm!;
}

async function makeTask(swarmId: string, title = "T") {
  const [task] = await db.insert(swarmTasks).values({ swarmId, title }).returning();
  return task!;
}

/** Starts a run of one role, with the defaults every case here shares. */
function start(
  values: {
    swarmId: string;
    role: "planner" | "subplanner" | "worker" | "resolver" | "judge";
    swarmTaskId?: string | null;
    agentProfileId?: string;
  },
  entitlements?: Entitlements,
) {
  return startRunIfIdle(
    db,
    {
      type: "swarm",
      swarmId: values.swarmId,
      role: values.role,
      ...(values.swarmTaskId ? { swarmTaskId: values.swarmTaskId } : {}),
      agentProfileId: values.agentProfileId ?? LOCAL_PROFILE,
      prompt: "",
    },
    entitlements,
  );
}

const isRun = (answer: unknown): answer is typeof agentRuns.$inferSelect =>
  typeof answer === "object" && answer !== null && "id" in answer;

test("a swarm that is not there answers gone rather than dying on a foreign key", async () => {
  const answer = await start({ swarmId: "55555555-5555-5555-5555-555555555555", role: "planner" });
  assert.equal(answer, "gone");
});

test("one planner per swarm", async () => {
  const swarm = await makeSwarm();
  const first = await start({ swarmId: swarm.id, role: "planner" });
  assert.ok(isRun(first), "the first planner starts");
  assert.equal(first.type, "swarm");
  assert.equal(first.role, "planner");
  assert.equal(first.swarmId, swarm.id);

  assert.equal(await start({ swarmId: swarm.id, role: "planner" }), "busy", "a second is refused");

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, first.id));
  const next = await start({ swarmId: swarm.id, role: "planner" });
  assert.ok(isRun(next), "and allowed again once the first has finished");

  // Another swarm's planner is not this swarm's business.
  const other = await makeSwarm();
  assert.ok(isRun(await start({ swarmId: other.id, role: "planner" })));
});

test("a sub planner is refused per group, not per swarm", async () => {
  const swarm = await makeSwarm();
  const groupA = await makeTask(swarm.id, "A");
  const groupB = await makeTask(swarm.id, "B");

  assert.ok(isRun(await start({ swarmId: swarm.id, role: "subplanner", swarmTaskId: groupA.id })));
  assert.equal(
    await start({ swarmId: swarm.id, role: "subplanner", swarmTaskId: groupA.id }),
    "busy",
    "a second on the same group is refused",
  );
  assert.ok(
    isRun(await start({ swarmId: swarm.id, role: "subplanner", swarmTaskId: groupB.id })),
    "another branch of the tree carries on",
  );
});

test("a sub planner or worker without a task is a caller bug, said loudly", async () => {
  const swarm = await makeSwarm();
  await assert.rejects(
    () => start({ swarmId: swarm.id, role: "worker" }),
    /must name its task/,
    "a worker with no leaf could never be attributed or finished",
  );
  await assert.rejects(() => start({ swarmId: swarm.id, role: "subplanner" }), /must name its task/);
});

test("one worker per leaf, and never more at once than the swarm allows", async () => {
  const swarm = await makeSwarm({ maxWorkers: 2 });
  const one = await makeTask(swarm.id, "one");
  const two = await makeTask(swarm.id, "two");
  const three = await makeTask(swarm.id, "three");

  const first = await start({ swarmId: swarm.id, role: "worker", swarmTaskId: one.id });
  assert.ok(isRun(first));
  assert.equal(first.swarmTaskId, one.id);
  assert.equal(
    await start({ swarmId: swarm.id, role: "worker", swarmTaskId: one.id }),
    "busy",
    "two agents on one branch is two agents editing each other's work",
  );

  assert.ok(isRun(await start({ swarmId: swarm.id, role: "worker", swarmTaskId: two.id })), "the ceiling is two");
  assert.equal(
    await start({ swarmId: swarm.id, role: "worker", swarmTaskId: three.id }),
    "busy",
    "and the third is refused",
  );

  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, first.id));
  assert.ok(
    isRun(await start({ swarmId: swarm.id, role: "worker", swarmTaskId: three.id })),
    "a finished worker frees its slot",
  );
});

test("the ceiling counts this swarm's workers and nobody else's", async () => {
  const mine = await makeSwarm({ maxWorkers: 1 });
  const theirs = await makeSwarm({ maxWorkers: 1 });
  assert.ok(isRun(await start({ swarmId: theirs.id, role: "worker", swarmTaskId: (await makeTask(theirs.id)).id })));
  assert.ok(
    isRun(await start({ swarmId: mine.id, role: "worker", swarmTaskId: (await makeTask(mine.id)).id })),
    "another swarm being full says nothing about this one",
  );
});

test("a resolver starts only for a landing that is actually in conflict", async () => {
  const swarm = await makeSwarm();
  const task = await makeTask(swarm.id);
  assert.equal(
    await start({ swarmId: swarm.id, role: "resolver" }),
    "busy",
    "with nothing conflicted there is nothing to resolve",
  );

  await db.insert(swarmLandings).values({ swarmId: swarm.id, taskId: task.id, status: "queued" });
  assert.equal(await start({ swarmId: swarm.id, role: "resolver" }), "busy", "a queued landing is not a conflict");

  await db
    .update(swarmLandings)
    .set({ status: "conflicted" })
    .where(eq(swarmLandings.swarmId, swarm.id));
  const resolver = await start({ swarmId: swarm.id, role: "resolver" });
  assert.ok(isRun(resolver), "a conflict is what a resolver is for");
  assert.equal(
    await start({ swarmId: swarm.id, role: "resolver" }),
    "busy",
    "one at a time: the queue lands one branch at a time",
  );
});

test("a judge is refused per leaf, and separately for the swarm as a whole", async () => {
  const swarm = await makeSwarm();
  const leaf = await makeTask(swarm.id);
  assert.ok(isRun(await start({ swarmId: swarm.id, role: "judge", swarmTaskId: leaf.id })));
  assert.equal(await start({ swarmId: swarm.id, role: "judge", swarmTaskId: leaf.id }), "busy");
  assert.ok(
    isRun(await start({ swarmId: swarm.id, role: "judge" })),
    "a judge of the whole swarm is not a judge of that leaf",
  );
  assert.equal(await start({ swarmId: swarm.id, role: "judge" }), "busy");
});

test("the plan is asked about the team whose swarm it is, and busy is asked first", async () => {
  const swarm = await makeSwarm({ projectId: TEAM_PROJECT, organizationId: "org-a" });
  const asked: string[] = [];
  const refusing = {
    canAddMember: async () => null,
    canActivateFeature: async () => null,
    canStartRun: async (organizationId: string) => {
      asked.push(organizationId);
      return { reason: "This team has used its agent hours for the month." };
    },
  } as unknown as Entitlements;

  const answer = await start({ swarmId: swarm.id, role: "planner", agentProfileId: TEAM_PROFILE }, refusing);
  assert.deepEqual(answer, { outOfCompute: "This team has used its agent hours for the month." });
  assert.deepEqual(asked, ["org-a"], "the organization comes off the locked swarm row");
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.swarmId, swarm.id));
  assert.equal(rows.length, 0, "a refused start inserts nothing");

  // Busy is the more specific answer, and a swarm already at work is
  // not a question about anybody's plan.
  const allowing = {
    canAddMember: async () => null,
    canActivateFeature: async () => null,
    canStartRun: async () => null,
  } as unknown as Entitlements;
  assert.ok(isRun(await start({ swarmId: swarm.id, role: "planner", agentProfileId: TEAM_PROFILE }, allowing)));
  asked.length = 0;
  assert.equal(await start({ swarmId: swarm.id, role: "planner", agentProfileId: TEAM_PROFILE }, refusing), "busy");
  assert.deepEqual(asked, [], "nobody's plan was asked about a swarm that is already busy");
});

test("a swarm outside any organization has no plan to ask", async () => {
  // Local mode, and a personal project in multi mode: there is nothing
  // to charge and nobody to charge it to.
  const swarm = await makeSwarm();
  const refusing = {
    canAddMember: async () => null,
    canActivateFeature: async () => null,
    canStartRun: async () => ({ reason: "no" }),
  } as unknown as Entitlements;
  assert.ok(isRun(await start({ swarmId: swarm.id, role: "planner" }, refusing)));
});
