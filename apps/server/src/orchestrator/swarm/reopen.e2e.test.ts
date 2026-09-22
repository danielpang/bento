import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { and, asc, eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runMigrations,
  swarmLandings,
  swarmMessages,
  swarmPullRequests,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { WorktreeManager } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import type { NewRun } from "../start-run.js";
import { publishSwarmCompletion } from "./complete.js";
import { tickSwarm, type SwarmTickDeps } from "./coordinator.js";
import { reopenRefusal, reopenSwarm } from "./reopen.js";
import { swarmWorkspaceKey } from "./sandbox.js";

/**
 * Reopening a finished swarm, all the way through.
 *
 * This is the exit criterion phase four is graded on, so it is driven
 * end to end rather than asserted a piece at a time: a swarm finishes
 * and publishes a pull request against a real bare repository, is
 * reopened with "address the review comments", grows a follow up
 * subtree under the node the reopen made, finishes again, and
 * publishes again. What is being proved is that the second publish
 * updates the first one's row and the first one's pull request instead
 * of opening a second one.
 *
 * The runs are stubbed, which is the coordinator test's own rule:
 * whether an agent actually starts is startRunIfIdle's test, and a
 * sandbox would prove nothing about which branch a publish pushed to.
 * The git and the GitHub call are not stubbed, because they are what
 * the criterion is about.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_reopen_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const TEMPLATE = "33333333-3333-3333-3333-333333333333";

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env: { ...process.env, ...IDENTITY } });
  return stdout.trim();
}

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let dataDir: string;
let repoPath: string;
let remotePath: string;
/** Every pull request GitHub was asked for, in order. */
let opened: { head: string; base: string; title: string; body: string }[];

/**
 * A GitHub that behaves the way GitHub does about a branch that
 * already has a pull request open on it: the same number comes back.
 * That is the behaviour the criterion turns on, so it is modelled
 * rather than assumed.
 */
const publisher = {
  async pushToken() {
    return "unused: the remote is a directory";
  },
  async ensurePullRequest(input: { owner: string; repo: string; head: string; base: string; title: string; body: string }) {
    opened.push({ head: input.head, base: input.base, title: input.title, body: input.body });
    return { prNumber: 7, url: `https://github.com/${input.owner}/${input.repo}/pull/7` };
  },
  async getPullRequest() {
    return { title: "", body: null, state: "open", merged: false };
  },
  async updatePullRequest() {},
  async pullRequestHasComment() {
    return false;
  },
  async createPullRequestComment() {},
};

/** The tick, with runs recorded rather than started. */
function stubbedDeps(): SwarmTickDeps & { started: NewRun[] } {
  const started: NewRun[] = [];
  return {
    started,
    /*
     * On the tick's own transaction, not on the pool. The tick holds
     * the swarm row locked, and agent_runs carries the trigger that
     * derives its organization from that very row, so an insert on a
     * second connection waits for a lock the tick is holding until it
     * hears back from this function.
     */
    async startRun(tx, values) {
      started.push(values);
      const [row] = await tx
        .insert(agentRuns)
        .values({ ...values, status: "queued" })
        .returning();
      return row!;
    },
    startLanding: async () => {},
  };
}

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
    `insert into swarm_templates (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers,worker_isolation)
     values ($1,'u1',null,'T',$2,$2,2,'worktree')`,
    [TEMPLATE, PROFILE],
  );

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-reopen-e2e-"));
  remotePath = path.join(dataDir, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remotePath]);
  repoPath = path.join(dataDir, "source");
  await exec("git", ["init", "--quiet", "-b", "main", repoPath]);
  await writeFile(path.join(repoPath, "shared.txt"), "one\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "--quiet", "-m", "base"]);
  await git(repoPath, ["remote", "add", "origin", remotePath]);
  await git(repoPath, ["push", "--quiet", "origin", "main"]);
  await pool.query(
    `insert into repositories (project_id,name,local_path,repo_url,default_branch,position)
     values ($1,'app',$2,'https://github.com/acme/app','main',0)`,
    [PROJECT, repoPath],
  );

  const bus = new EventBus();
  const emitted: BoardEvent[] = [];
  opened = [];
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    userId: "u1",
    worktrees: new WorktreeManager(dataDir),
    driver: { provider: "docker" },
    boss: {
      send: async () => "job",
      work: async () => "worker",
      offWork: async () => {},
      notifyWorker: () => {},
    },
    runWorkers: [],
  } as unknown as AppContext;
  bus.onBoardEvent(PROJECT, (event) => emitted.push(event));
});

after(async () => {
  await pool?.end();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("delete from swarms");
  opened.length = 0;
});

/**
 * A swarm that has finished its first pass: a plan node, a landed
 * leaf, and the work on the swarm's branch in a worktree the publish
 * can read, exactly as the merge queue leaves it.
 */
async function finishedSwarm(slug: string) {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug,
      title: "Rewrite the checkout",
      goal: "Replace the checkout with the hosted card field.",
      templateId: TEMPLATE,
      status: "done",
      branchName: `swarm/${slug}`,
      budgetUsd: "20",
    })
    .returning();
  await git(repoPath, ["branch", `swarm/${slug}`, "main"]);
  const tree = ctx.worktrees.worktreePath(swarmWorkspaceKey(swarm!.id), "app");
  await mkdir(path.dirname(tree), { recursive: true });
  await git(repoPath, ["worktree", "add", "--quiet", tree, `swarm/${slug}`]);

  const [plan] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, title: "Cart", nodeType: "plan", status: "done", position: 0 })
    .returning();
  const [leaf] = await db
    .insert(swarmTasks)
    .values({
      swarmId: swarm!.id,
      parentId: plan!.id,
      title: "Line item totals",
      status: "done",
      position: 0,
      branchName: `swarm/${slug}-aaaaaaaa`,
    })
    .returning();
  await db.insert(swarmLandings).values({
    swarmId: swarm!.id,
    taskId: leaf!.id,
    branchName: leaf!.branchName,
    status: "landed",
    position: 0,
  });

  await writeFile(path.join(tree, "totals.ts"), "export const total = 1;\n");
  await git(tree, ["add", "."]);
  await git(tree, ["commit", "--quiet", "-m", "Line item totals"]);
  return { swarm: swarm!, plan: plan!, leaf: leaf!, tree };
}

const prRows = (swarmId: string) => db.select().from(swarmPullRequests).where(eq(swarmPullRequests.swarmId, swarmId));

/* ---------------------------------------------------------------- */

test("a finished swarm reopened with a follow up lands a new subtree and updates the same pull request", async () => {
  const fx = await finishedSwarm("checkout");

  // The first pass publishes, which is the pull request the review
  // comments will arrive on.
  const first = await publishSwarmCompletion(ctx, fx.swarm, publisher, { remoteUrl: () => remotePath });
  assert.deepEqual(first.failures, []);
  assert.equal(first.published.length, 1);
  const firstRows = await prRows(fx.swarm.id);
  assert.equal(firstRows.length, 1);
  const firstHead = firstRows[0]!.headSha;

  // Then the review comes back.
  const reopened = await reopenSwarm(db, fx.swarm, {
    instruction: "Address the review comments on the totals module.",
    budgetUsd: 40,
    actorUserId: "u1",
  });
  assert.ok(!("refused" in reopened), "a done swarm with budget left can be reopened");
  if ("refused" in reopened) return;

  assert.equal(reopened.swarm.status, "running", "the swarm is working again");
  assert.equal(reopened.swarm.reopenCount, 1);
  assert.equal(
    reopened.swarm.branchName,
    `swarm/checkout`,
    "and it is the same branch, which is what keeps the pull request the same one",
  );

  // The follow up node, at the top of the tree, carrying what it was
  // asked for. This is what both views label a subtree by.
  const [node] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, reopened.followUpTaskId));
  assert.equal(node!.parentId, null, "the follow up is a root of its own, not a child of the first pass");
  assert.equal(node!.nodeType, "plan");
  assert.equal(node!.followUpInstruction, "Address the review comments on the totals module.");
  assert.equal(node!.title, "Follow up 1");

  // The first pass is untouched: a reopen adds work, it does not
  // retract what was accepted.
  const [was] = await db.select().from(swarmTasks).where(eq(swarmTasks.id, fx.leaf.id));
  assert.equal(was!.status, "done");

  // The planner hears it: the person's own words, and Bento's notice
  // naming the node to hang the work off.
  const messages = await db
    .select()
    .from(swarmMessages)
    .where(eq(swarmMessages.swarmId, fx.swarm.id))
    .orderBy(asc(swarmMessages.createdAt));
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.source, "person");
  assert.match(messages[0]!.text, /Address the review comments/);
  assert.equal(messages[1]!.source, "system");
  assert.match(messages[1]!.text, new RegExp(reopened.followUpTaskId));
  assert.match(messages[1]!.text, /updated rather than replaced/);

  /*
   * What the planner then does, written out rather than run: a leaf
   * under the follow up node, worked, landed. Stubbing the agent is
   * the point of the coordinator's own tests; what this one is about
   * starts again below.
   */
  const [followUpLeaf] = await db
    .insert(swarmTasks)
    .values({
      swarmId: fx.swarm.id,
      parentId: reopened.followUpTaskId,
      title: "Rename the totals helper",
      status: "done",
      position: 0,
      branchName: `swarm/checkout-bbbbbbbb`,
    })
    .returning();
  await db.insert(swarmLandings).values({
    swarmId: fx.swarm.id,
    taskId: followUpLeaf!.id,
    branchName: followUpLeaf!.branchName,
    status: "landed",
    position: 1,
  });
  await writeFile(path.join(fx.tree, "totals.ts"), "export const orderTotal = 1;\n");
  await git(fx.tree, ["add", "."]);
  await git(fx.tree, ["commit", "--quiet", "-m", "Rename the totals helper"]);

  // The tick is what notices the tree finished a second time.
  const result = await tickSwarm(ctx, fx.swarm.id, stubbedDeps());
  assert.equal(result?.status, "done", "the reopened swarm is done once its follow up is");
  assert.equal(result?.becameDone, true, "and the transition is what asks for the publish");

  const [afterTick] = await db.select().from(swarms).where(eq(swarms.id, fx.swarm.id));
  const second = await publishSwarmCompletion(ctx, afterTick!, publisher, { remoteUrl: () => remotePath });
  assert.deepEqual(second.failures, []);
  assert.equal(second.published.length, 1);

  // The criterion, read out of Postgres and out of git rather than
  // off the result: one row, the same number, a moved head.
  const rows = await prRows(fx.swarm.id);
  assert.equal(rows.length, 1, "one pull request, not two");
  assert.equal(rows[0]!.number, 7);
  const head = await git(fx.tree, ["rev-parse", "HEAD"]);
  assert.equal(rows[0]!.headSha, head, "the row holds the commit the second publish pushed");
  assert.notEqual(rows[0]!.headSha, firstHead, "which is not the commit the first one did");
  assert.equal(
    await git(remotePath, ["rev-parse", "refs/heads/swarm/checkout"]),
    head,
    "and the remote branch really moved",
  );
  assert.equal(
    await git(remotePath, ["show", "refs/heads/swarm/checkout:totals.ts"]),
    "export const orderTotal = 1;",
    "to the follow up's work",
  );

  // Both publishes asked GitHub about the same branch, which is why
  // GitHub gave back the same pull request.
  assert.equal(opened.length, 2);
  assert.equal(opened[0]!.head, "swarm/checkout");
  assert.equal(opened[1]!.head, "swarm/checkout");
  assert.match(opened[1]!.body, /Follow up 1/, "and the body now names the follow up");
});

test("a swarm that is still running cannot be reopened", async () => {
  const fx = await finishedSwarm("running-one");
  await db.update(swarms).set({ status: "running" }).where(eq(swarms.id, fx.swarm.id));
  const [live] = await db.select().from(swarms).where(eq(swarms.id, fx.swarm.id));

  const refused = await reopenSwarm(db, live!, { instruction: "more please" });
  assert.ok("refused" in refused);
  if (!("refused" in refused)) return;
  assert.equal(refused.code, "NOT_FINISHED");
  assert.equal(await db.select().from(swarmTasks).where(eq(swarmTasks.followUpInstruction, "more please")).then((r) => r.length), 0);
});

test("a swarm that spent its budget is refused unless the reopen raises it", async () => {
  const fx = await finishedSwarm("broke");
  await db
    .update(swarms)
    .set({ status: "budget_exhausted", budgetUsd: "10", spentMeasuredUsd: "10" })
    .where(eq(swarms.id, fx.swarm.id));
  const [spent] = await db.select().from(swarms).where(eq(swarms.id, fx.swarm.id));

  const refused = reopenRefusal(spent!, {});
  assert.equal(refused?.code, "BUDGET", "reopening it as it stands would start nothing");
  assert.match(refused!.refused, /Raise the budget/);

  assert.equal(reopenRefusal(spent!, { budgetUsd: 25 }), null, "raising it in the same call is the way through");

  const reopened = await reopenSwarm(db, spent!, { instruction: "one more thing", budgetUsd: 25 });
  assert.ok(!("refused" in reopened));
  if ("refused" in reopened) return;
  assert.equal(reopened.swarm.budgetUsd, "25");
  assert.equal(reopened.swarm.budgetWarnedAt, null, "a raised budget is a different budget, so the latch is cleared");
});

test("a swarm that ran past its clock is refused unless the reopen raises that too", async () => {
  const fx = await finishedSwarm("slow");
  await db
    .update(swarms)
    .set({ status: "timed_out", pausedReason: "time_limit", timeLimitMin: 60 })
    .where(eq(swarms.id, fx.swarm.id));
  const [late] = await db.select().from(swarms).where(eq(swarms.id, fx.swarm.id));

  assert.equal(reopenRefusal(late!, {})?.code, "TIME_LIMIT");
  assert.equal(reopenRefusal(late!, { timeLimitMin: 30 })?.code, "TIME_LIMIT", "lowering it is not raising it");
  assert.equal(reopenRefusal(late!, { timeLimitMin: 240 }), null);
  assert.equal(reopenRefusal(late!, { timeLimitMin: null }), null, "and clearing it is allowed");
});

test("reopening twice makes a second subtree rather than adding to the first", async () => {
  const fx = await finishedSwarm("twice");
  const one = await reopenSwarm(db, fx.swarm, { instruction: "first follow up" });
  assert.ok(!("refused" in one));
  if ("refused" in one) return;

  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, fx.swarm.id));
  const [again] = await db.select().from(swarms).where(eq(swarms.id, fx.swarm.id));
  const two = await reopenSwarm(db, again!, { instruction: "second follow up" });
  assert.ok(!("refused" in two));
  if ("refused" in two) return;

  assert.notEqual(one.followUpTaskId, two.followUpTaskId);
  assert.equal(two.followUp, 2);
  const roots = await db
    .select()
    .from(swarmTasks)
    .where(and(eq(swarmTasks.swarmId, fx.swarm.id), eq(swarmTasks.nodeType, "plan")))
    .orderBy(asc(swarmTasks.position));
  const followUps = roots.filter((row) => row.followUpInstruction !== null);
  assert.deepEqual(
    followUps.map((row) => row.title),
    ["Follow up 1", "Follow up 2"],
  );
  assert.ok(
    followUps[0]!.position < followUps[1]!.position,
    "the second sits after the first, so the tree reads in the order it happened",
  );
});
