import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, createPool, repositories, runMigrations, swarmLandings, swarmTasks, swarms, type Db } from "@bento/db";
import { WorktreeManager, type SandboxDriver } from "@bento/sandbox";
import { singleDriver } from "../sandbox-driver.js";
import type { AppContext } from "../../context.js";
import { EventBus } from "../../events.js";
import { loadEnv } from "../../env.js";
import { publishStackedPullRequests, publishSwarmCompletion } from "./complete.js";
import { pushSwarmBranch, pushTaskBranch, remoteBranchBundles } from "./remote-branches.js";
import { swarmTaskWorkspaceKey, swarmWorkspaceKey } from "./sandbox.js";

/**
 * A swarm's branches reach the remote as the swarm goes, and the pull
 * requests are opened from them at the end, either one for the swarm
 * or one per task, stacked.
 *
 * Against a bare repository on disk standing in for GitHub, with the
 * checkouts on this host, which is the only way the git half of this
 * runs without a GitHub connection. The machines are the host's
 * worktrees here; a clone driver differs only in where the bundle is
 * exported from.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_remote_branches_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const REPO_URL = "https://github.com/acme/app";

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
let opened: { head: string; base: string; title: string; body: string }[];

const publisher = {
  async pushToken() {
    return "unused: the remote is a directory";
  },
  async ensurePullRequest(input: { owner: string; repo: string; head: string; base: string; title: string; body: string }) {
    opened.push(input);
    return { prNumber: 100 + opened.length, url: `https://github.com/${input.owner}/${input.repo}/pull/${100 + opened.length}` };
  },
  async getPullRequest() {
    return { title: "", body: null, state: "open", merged: false };
  },
  async updatePullRequest() {},
  async pullRequestHasComment() {
    return false;
  },
  async createPullRequestComment() {},
} as unknown as Parameters<typeof publishSwarmCompletion>[2];

const options = { publisher, remoteUrl: () => remotePath };

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

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-remote-branches-e2e-"));
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
     values ($1,'app',$2,$3,'main',0)`,
    [PROJECT, repoPath, REPO_URL],
  );

  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus: new EventBus(),
    userId: "u1",
    worktrees: new WorktreeManager(dataDir),
    drivers: singleDriver({ provider: "docker", workspace: "host" } as unknown as SandboxDriver),
    boss: { send: async () => "job", work: async () => "worker", offWork: async () => {}, notifyWorker: () => {} },
    runWorkers: [],
  } as unknown as AppContext;
});

after(async () => {
  await pool?.end();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  opened = [];
});

const remoteHead = (branch: string) => git(remotePath, ["rev-parse", `refs/heads/${branch}`]);

async function swarmOnHost(slug: string) {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug,
      title: "Rewrite the checkout",
      goal: "Replace the checkout.",
      plannerProfileId: PROFILE,
      workerProfileId: PROFILE,
      workerIsolation: "worktree",
      status: "running",
      branchName: `swarm/${slug}`,
    })
    .returning();
  await git(repoPath, ["branch", `swarm/${slug}`, "main"]);
  const tree = ctx.worktrees.worktreePath(swarmWorkspaceKey(swarm!.id), "app");
  await mkdir(path.dirname(tree), { recursive: true });
  await git(repoPath, ["worktree", "add", "--quiet", tree, `swarm/${slug}`]);
  return { swarm: swarm!, tree };
}

/** A worker's branch cut from the swarm's, with one commit on it. */
async function workerCommits(swarm: typeof swarms.$inferSelect, title: string, file: string, position: number) {
  const branch = `${swarm.branchName}-${title.toLowerCase()}`;
  const [task] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm.id, title, status: "working", position, branchName: branch, description: `Do ${title}.` })
    .returning();
  await git(repoPath, ["branch", branch, swarm.branchName!]);
  const tree = ctx.worktrees.worktreePath(swarmTaskWorkspaceKey(swarm.id, task!.id), "app");
  await mkdir(path.dirname(tree), { recursive: true });
  await git(repoPath, ["worktree", "add", "--quiet", tree, branch]);
  await writeFile(path.join(tree, file), `${title}\n`);
  await git(tree, ["add", "."]);
  await git(tree, ["commit", "--quiet", "-m", title]);
  return { task: task!, tree, branch };
}

/** What the merge queue does: the swarm's branch takes the worker's, and the task records the head. */
async function land(swarmTree: string, worker: { task: typeof swarmTasks.$inferSelect; branch: string }) {
  await git(swarmTree, ["merge", "--quiet", "--ff-only", worker.branch]);
  const head = await git(swarmTree, ["rev-parse", "HEAD"]);
  await db
    .update(swarmTasks)
    .set({
      status: "done",
      flags: sql`coalesce(${swarmTasks.flags}, '{}'::jsonb) || ${JSON.stringify({ landedHeads: { app: head } })}::jsonb`,
    })
    .where(eq(swarmTasks.id, worker.task.id));
  await db.insert(swarmLandings).values({
    swarmId: worker.task.swarmId,
    taskId: worker.task.id,
    branchName: worker.branch,
    status: "landed",
    position: worker.task.position,
    endedAt: new Date(),
  });
  return head;
}

const readSwarm = async (id: string) => (await db.select().from(swarms).where(eq(swarms.id, id)))[0]!;
const readTask = async (id: string) => (await db.select().from(swarmTasks).where(eq(swarmTasks.id, id)))[0]!;

test("a worker's branch reaches the remote when its run ends, and the lease is recorded", async () => {
  const { swarm } = await swarmOnHost("push-worker");
  const worker = await workerCommits(swarm, "Cart", "cart.ts", 0);

  await pushTaskBranch(ctx, worker.task.id, options);

  const pushed = await remoteHead(worker.branch);
  assert.equal(pushed, await git(worker.tree, ["rev-parse", "HEAD"]), "the commit that arrived is the worker's");
  const flags = (await readTask(worker.task.id)).flags as { pushedHeads?: Record<string, string> };
  assert.equal(flags.pushedHeads?.[REPO_URL], pushed, "and it is the lease the next push holds");
});

test("each landing pushes the swarm's branch and the task's branch in its landed form, and the tasks stack", async () => {
  const { swarm, tree } = await swarmOnHost("stacked");
  const first = await workerCommits(swarm, "Cart", "cart.ts", 0);
  await pushTaskBranch(ctx, first.task.id, options);
  const firstHead = await land(tree, first);
  await pushSwarmBranch(ctx, swarm.id, first.task.id, options);

  const second = await workerCommits(swarm, "Totals", "totals.ts", 1);
  await pushTaskBranch(ctx, second.task.id, options);
  const secondHead = await land(tree, second);
  await pushSwarmBranch(ctx, swarm.id, second.task.id, options);

  assert.equal(await remoteHead(swarm.branchName!), secondHead, "the swarm's branch on the remote is the machine's");
  assert.equal(await remoteHead(first.branch), firstHead, "task one's branch is the swarm's head when it landed");
  assert.equal(await remoteHead(second.branch), secondHead);
  assert.equal((await readSwarm(swarm.id)).pushedHeads[REPO_URL], secondHead);

  // Landed: a late retry of the worker's own push must not undo the landed form.
  await pushTaskBranch(ctx, first.task.id, options);
  assert.equal(await remoteHead(first.branch), firstHead);

  await db.update(swarms).set({ status: "done" }).where(eq(swarms.id, swarm.id));
  const stacked = await publishStackedPullRequests(ctx, await readSwarm(swarm.id), publisher, { remoteUrl: () => remotePath });
  assert.deepEqual(stacked.failures, []);
  assert.deepEqual(
    opened.map((pr) => [pr.head, pr.base]),
    [
      [first.branch, "main"],
      [second.branch, first.branch],
    ],
    "each task's pull request is against the task before it",
  );
  assert.match(opened[1]!.body, /Part 2 of 2/);
  const prs = ((await readTask(second.task.id)).flags as { pullRequests?: Record<string, { number: number }> }).pullRequests;
  assert.ok(prs?.[REPO_URL]?.number, "the task records its pull request");

  // The combined pull request still works after the early pushes: its
  // lease is the commit those pushes recorded, not a stale one.
  opened = [];
  const combined = await publishSwarmCompletion(ctx, await readSwarm(swarm.id), publisher, { remoteUrl: () => remotePath });
  assert.deepEqual(combined.failures, []);
  assert.deepEqual(opened.map((pr) => [pr.head, pr.base]), [[swarm.branchName, "main"]]);
});

test("a branch on the remote is read back for a machine that is gone", async () => {
  const { swarm, tree } = await swarmOnHost("restore");
  const worker = await workerCommits(swarm, "Cart", "cart.ts", 0);
  const head = await land(tree, worker);
  await pushSwarmBranch(ctx, swarm.id, worker.task.id, options);

  const repoRows = await db.select().from(repositories).where(eq(repositories.projectId, PROJECT));
  const bundles = await remoteBranchBundles(
    ctx,
    {
      organizationId: null,
      branch: swarm.branchName!,
      pushedHeads: (await readSwarm(swarm.id)).pushedHeads,
      repoRows,
    },
    options,
  );
  const bundle = bundles.get("app");
  assert.ok(bundle, "the swarm's branch came back");
  assert.equal(bundle.headSha, head);

  // And it is a bundle git takes: fetched into a fresh clone of the base, it is the branch.
  const fresh = path.join(dataDir, "fresh");
  await exec("git", ["clone", "--quiet", "--branch", "main", remotePath, fresh]);
  const file = path.join(dataDir, "restore.bundle");
  await writeFile(file, bundle.data);
  await git(fresh, ["fetch", "--quiet", file, `+refs/heads/${swarm.branchName}:refs/heads/${swarm.branchName}`]);
  assert.equal(await git(fresh, ["rev-parse", `refs/heads/${swarm.branchName}`]), head);
});

test("a branch somebody else pushed to is refused rather than forced over", async () => {
  const { swarm, tree } = await swarmOnHost("lease");
  const worker = await workerCommits(swarm, "Cart", "cart.ts", 0);
  await land(tree, worker);
  await pushSwarmBranch(ctx, swarm.id, worker.task.id, options);

  // A person pushes a commit of their own to the swarm's branch.
  const theirs = path.join(dataDir, "theirs");
  await exec("git", ["clone", "--quiet", "--branch", swarm.branchName!, remotePath, theirs]);
  await writeFile(path.join(theirs, "mine.txt"), "mine\n");
  await git(theirs, ["add", "."]);
  await git(theirs, ["commit", "--quiet", "-m", "theirs"]);
  await git(theirs, ["push", "--quiet", "origin", swarm.branchName!]);
  const their = await git(theirs, ["rev-parse", "HEAD"]);

  // The swarm moves on and pushes again.
  await writeFile(path.join(tree, "more.ts"), "more\n");
  await git(tree, ["add", "."]);
  await git(tree, ["commit", "--quiet", "-m", "more"]);
  await assert.rejects(pushSwarmBranch(ctx, swarm.id, undefined, options), /branch moved on GitHub/);
  assert.equal(await remoteHead(swarm.branchName!), their, "their commit is still there");
});
