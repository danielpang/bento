import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runArtifacts,
  runMigrations,
  swarmLandings,
  swarmPullRequests,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { WorktreeManager } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import { SWARM_DESIGN_PATH } from "../../mcp/swarm-server.js";
import { publishFinishedSwarm, publishSwarmCompletion, swarmPullRequestBody } from "./complete.js";
import { swarmWorkspaceKey } from "./sandbox.js";

/**
 * A finished swarm, published.
 *
 * Against a bare repository on disk rather than against GitHub, which
 * is how `publish.test.ts` proves the card path and the only way any of
 * this runs outside a deployment that has a GitHub connection. What is
 * being asserted is everything between "the root is done" and "there is
 * a row with a pull request on it": that the swarm's branch really
 * reaches a remote, that the commit the row records is the commit that
 * arrived, that the body says what a reviewer needs, and that running
 * the whole thing twice leaves one pull request rather than two.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_complete_test";
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
let emitted: BoardEvent[];
let dataDir: string;
let repoPath: string;
let remotePath: string;

/** What the fake GitHub was asked to open, so the body can be read. */
let opened: { owner: string; repo: string; head: string; base: string; title: string; body: string }[];

const publisher = {
  async pushToken() {
    return "unused: the remote is a directory";
  },
  async ensurePullRequest(input: {
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) {
    opened.push(input);
    // The same number every time, which is what GitHub answers for a
    // pull request that is already open on this branch.
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
    `insert into swarm_templates (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers)
     values ($1,'u1',null,'T',$2,$2,2)`,
    [TEMPLATE, PROFILE],
  );

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-complete-e2e-"));

  // A bare repository standing in for GitHub, and a checkout of it
  // that is the project's repository on this host.
  remotePath = path.join(dataDir, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remotePath]);
  repoPath = path.join(dataDir, "source");
  await exec("git", ["init", "--quiet", "-b", "main", repoPath]);
  await writeFile(path.join(repoPath, "shared.txt"), "one\ntwo\nthree\n");
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
  emitted = [];
  opened = [];
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    userId: "u1",
    worktrees: new WorktreeManager(dataDir),
    // Checkouts on this host, which is what the worktree half of the
    // publish reads. Nothing here execs.
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
  emitted.length = 0;
  opened.length = 0;
});

/**
 * A swarm whose merge queue has already run: a branch with a leaf's
 * work on it, a tree, and a landing row saying the leaf landed.
 *
 * Built through the same WorktreeManager and workspace key the
 * executor uses, so the checkout the publish reads is the one a real
 * swarm would have written to.
 */
async function finishedSwarm(slug: string, options: { design?: string } = {}) {
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
    })
    .returning();
  await git(repoPath, ["branch", `swarm/${slug}`, "main"]);
  const tree = ctx.worktrees.worktreePath(swarmWorkspaceKey(swarm!.id), "app");
  await mkdir(path.dirname(tree), { recursive: true });
  await git(repoPath, ["worktree", "add", "--quiet", tree, `swarm/${slug}`]);

  const [plan] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, title: "Cart", kind: "plan", status: "done", position: 0 })
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

  // The work itself, on the swarm's branch, as the merge queue leaves it.
  await writeFile(path.join(tree, "totals.ts"), "export const total = 1;\n");
  await git(tree, ["add", "."]);
  await git(tree, ["commit", "--quiet", "-m", "Line item totals"]);

  if (options.design) {
    const [run] = await db
      .insert(agentRuns)
      .values({
        type: "swarm",
        role: "planner",
        swarmId: swarm!.id,
        agentProfileId: PROFILE,
        prompt: "plan it",
        status: "succeeded",
      })
      .returning();
    await db.insert(runArtifacts).values({
      runId: run!.id,
      type: "swarm",
      swarmId: swarm!.id,
      stageSlug: "plan",
      stageName: "Plan",
      path: SWARM_DESIGN_PATH,
      kind: "markdown",
      mime: "text/markdown",
      size: Buffer.byteLength(options.design, "utf8"),
      content: options.design,
    });
  }

  return { swarm: swarm!, plan: plan!, leaf: leaf!, tree };
}

const prRows = async (swarmId: string) =>
  db.select().from(swarmPullRequests).where(eq(swarmPullRequests.swarmId, swarmId));

/* ---------------------------------------------------------------- */

test("a finished swarm pushes its branch and records the pull request it opened", async () => {
  const fx = await finishedSwarm("clean", { design: "## Approach\nOne module per payment path." });

  const result = await publishSwarmCompletion(ctx, fx.swarm, publisher, { remoteUrl: () => remotePath });

  assert.deepEqual(result.failures, []);
  assert.equal(result.skipped, null);
  assert.equal(result.published.length, 1);
  assert.equal(result.published[0]!.prNumber, 7);

  // The branch really arrived, at the commit the swarm's checkout is on.
  const head = await git(fx.tree, ["rev-parse", "HEAD"]);
  const pushed = await git(remotePath, ["rev-parse", `refs/heads/swarm/clean`]);
  assert.equal(pushed, head, "what the remote has is what the swarm's branch had");
  assert.equal(
    await git(remotePath, ["show", "refs/heads/swarm/clean:totals.ts"]),
    "export const total = 1;",
    "and the work is in it",
  );

  // And the row, read back out of Postgres rather than off the result.
  const rows = await prRows(fx.swarm.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.number, 7);
  assert.equal(rows[0]!.url, "https://github.com/acme/app/pull/7");
  assert.equal(rows[0]!.repoUrl, "https://github.com/acme/app");
  assert.equal(rows[0]!.headSha, head, "the head is the lease the next publish holds");

  // The body a reviewer opens, which is the whole of what they get.
  const body = opened[0]!.body;
  assert.equal(opened[0]!.head, "swarm/clean");
  assert.equal(opened[0]!.base, "main");
  assert.match(body, /Replace the checkout with the hosted card field\./, "the goal");
  assert.match(body, /One module per payment path\./, "the planner's write-up");
  assert.match(body, /- Cart \(done\)/, "the tree");
  assert.match(body, /\n {2}- Line item totals \(done\)/, "and its leaves under it");
  assert.match(body, /## What landed on this branch\n\n- Line item totals/);

  assert.ok(
    emitted.some((event) => event.type === "swarm_updated" && event.swarmId === fx.swarm.id),
    "the header is told there is something to draw",
  );
});

test("publishing the same finished swarm twice leaves one pull request", async () => {
  /**
   * Which is what a redelivered pg-boss job is, and what a second
   * machine picking the job up does. The row is an upsert keyed by
   * swarm and repository, and GitHub answers the second open with the
   * pull request it already has.
   */
  const fx = await finishedSwarm("twice");
  await publishSwarmCompletion(ctx, fx.swarm, publisher, { remoteUrl: () => remotePath });
  const head = await git(remotePath, ["rev-parse", "refs/heads/swarm/twice"]);

  const second = await publishSwarmCompletion(ctx, fx.swarm, publisher, { remoteUrl: () => remotePath });
  assert.deepEqual(second.failures, [], "the second push holds its own lease and is allowed");

  const rows = await prRows(fx.swarm.id);
  assert.equal(rows.length, 1, "one pull request, not one per delivery");
  assert.equal(rows[0]!.number, 7);
  assert.equal(await git(remotePath, ["rev-parse", "refs/heads/swarm/twice"]), head);
});

test("a swarm somebody pushed to since is refused rather than forced over", async () => {
  /**
   * The lease, which is the reason the head is recorded at all. A
   * person who pushed a review fix onto the swarm's branch must not
   * have it deleted by a republish.
   */
  const fx = await finishedSwarm("leased");
  await publishSwarmCompletion(ctx, fx.swarm, publisher, { remoteUrl: () => remotePath });

  // Somebody else's commit, straight onto the branch on the remote.
  const theirs = path.join(dataDir, "theirs");
  await exec("git", ["clone", "--quiet", "--branch", "swarm/leased", remotePath, theirs]);
  await writeFile(path.join(theirs, "review.txt"), "one more thing\n");
  await git(theirs, ["add", "."]);
  await git(theirs, ["commit", "--quiet", "-m", "review fix"]);
  await git(theirs, ["push", "--quiet", "origin", "swarm/leased"]);
  const theirHead = await git(theirs, ["rev-parse", "HEAD"]);

  // A new commit on the swarm's side, so there is something to push.
  await writeFile(path.join(fx.tree, "more.ts"), "export const more = 2;\n");
  await git(fx.tree, ["add", "."]);
  await git(fx.tree, ["commit", "--quiet", "-m", "more"]);

  const again = await publishSwarmCompletion(ctx, fx.swarm, publisher, { remoteUrl: () => remotePath });
  assert.equal(again.published.length, 0);
  assert.match(again.failures[0]?.reason ?? "", /moved on GitHub since Bento last pushed it/);
  assert.equal(
    await git(remotePath, ["rev-parse", "refs/heads/swarm/leased"]),
    theirHead,
    "their commit is still the branch",
  );
});

test("a swarm that is not finished is not published", async () => {
  const fx = await finishedSwarm("running");
  await db.update(swarms).set({ status: "running" }).where(eq(swarms.id, fx.swarm.id));

  const result = await publishFinishedSwarm(ctx, fx.swarm.id);
  assert.match(result?.skipped ?? "", /is running, not done/);
  assert.deepEqual(await prRows(fx.swarm.id), []);
});

test("a deployment with no GitHub connection says so and pushes nothing", async () => {
  const fx = await finishedSwarm("nogithub");
  const result = await publishFinishedSwarm(ctx, fx.swarm.id);
  assert.match(result?.skipped ?? "", /no GitHub connection is configured/);
  assert.match(result?.skipped ?? "", /It is in the repository/, "and says where the work still is");
  assert.deepEqual(await prRows(fx.swarm.id), []);
});

test("the body names the goal, the plan and the landed work even with nothing else to say", () => {
  const body = swarmPullRequestBody({
    title: "Rewrite the checkout",
    goal: "",
    writeUp: null,
    tasks: [],
    landedTaskIds: [],
  });
  assert.match(body, /Opened by Bento for the swarm "Rewrite the checkout"\./);
  assert.match(body, /## Goal\n\n\(none given\)/);
  assert.doesNotMatch(body, /## What the planner wrote/, "a section with nothing in it is not drawn");
  assert.match(body, /Nothing landed through the merge queue\./);
});
