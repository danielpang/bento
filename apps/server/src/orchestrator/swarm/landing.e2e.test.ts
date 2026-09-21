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
  runMigrations,
  swarmLandings,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { WorktreeManager } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import { taskTrailer, workerBranchName } from "./branches.js";
import { commitsForTask } from "./landing-git.js";
import { performLanding } from "./landing.js";
import { swarmTaskWorkspaceKey, swarmWorkspaceKey } from "./sandbox.js";

/**
 * The merge queue against real rows and real repositories.
 *
 * landing-git.test.ts proves the git; this proves what the rows say
 * afterwards, which is the half that decides whether the swarm carries
 * on. The two are separate because they fail for different reasons: a
 * rebase that loses a commit and a row that says "landed" over a branch
 * that never moved are not the same bug, and a test that mixed them
 * would find neither clearly.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_landing_test";
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
let queued: { queue: string; data: Record<string, unknown> }[];
let dataDir: string;
let repoPath: string;

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

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-landing-e2e-"));
  repoPath = path.join(dataDir, "source");
  await exec("git", ["init", "--quiet", "-b", "main", repoPath]);
  await writeFile(path.join(repoPath, "shared.txt"), "one\ntwo\nthree\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "--quiet", "-m", "base"]);
  await pool.query(
    `insert into repositories (project_id,name,local_path,default_branch,position) values ($1,'app',$2,'main',0)`,
    [PROJECT, repoPath],
  );

  const bus = new EventBus();
  emitted = [];
  queued = [];
  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus,
    userId: "u1",
    worktrees: new WorktreeManager(dataDir),
    boss: {
      send: async (queue: string, data: unknown) => {
        queued.push({ queue, data: data as Record<string, unknown> });
        return "job";
      },
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
  queued.length = 0;
});

/**
 * A swarm with its branch and its checkout, one leaf with a branch and
 * a checkout of its own, and a landing row at the front of the queue.
 *
 * Built the way the executor builds it, through the same WorktreeManager
 * and the same workspace keys, so the paths the landing looks in are the
 * paths a real run would have written to. A fixture that made its own
 * directories would prove the git and nothing about the wiring.
 */
async function swarmWithLeaf(slug: string) {
  const [swarm] = await db
    .insert(swarms)
    .values({ projectId: PROJECT, slug, title: "S", templateId: TEMPLATE, status: "running", branchName: `swarm/${slug}` })
    .returning();
  await git(repoPath, ["branch", `swarm/${slug}`, "main"]);
  const swarmTree = ctx.worktrees.worktreePath(swarmWorkspaceKey(swarm!.id), "app");
  await mkdir(path.dirname(swarmTree), { recursive: true });
  await git(repoPath, ["worktree", "add", "--quiet", swarmTree, `swarm/${slug}`]);

  const [task] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, title: "Add the empty cart state", status: "working", report: "did it" })
    .returning();
  const branch = workerBranchName(`swarm/${slug}`, task!.id);
  await db.update(swarmTasks).set({ branchName: branch }).where(eq(swarmTasks.id, task!.id));
  await git(repoPath, ["branch", branch, `swarm/${slug}`]);
  const workerTree = ctx.worktrees.worktreePath(swarmTaskWorkspaceKey(swarm!.id, task!.id), "app");
  await mkdir(path.dirname(workerTree), { recursive: true });
  await git(repoPath, ["worktree", "add", "--quiet", workerTree, branch]);

  return { swarm: swarm!, task: { ...task!, branchName: branch }, swarmTree, workerTree, branch };
}

async function queueLanding(swarmId: string, taskId: string, branch: string, position = 0) {
  const [row] = await db
    .insert(swarmLandings)
    .values({ swarmId, taskId, branchName: branch, position, status: "landing", attempt: 1 })
    .returning();
  return row!;
}

async function commitIn(tree: string, taskId: string, file: string, contents: string, subject = "work") {
  await writeFile(path.join(tree, file), contents);
  await git(tree, ["add", "."]);
  await git(tree, ["commit", "--quiet", "-m", `${subject}\n\n${taskTrailer(taskId)}`]);
}

const landingRow = async (id: string) =>
  (await db.select().from(swarmLandings).where(eq(swarmLandings.id, id)))[0];
const taskRow = async (id: string) => (await db.select().from(swarmTasks).where(eq(swarmTasks.id, id)))[0];

/* ---------------------------------------------------------------- */

test("a leaf that lands is done, its branch is on the swarm's, and its machine is asked for", async () => {
  const fx = await swarmWithLeaf("clean");
  await commitIn(fx.workerTree, fx.task.id, "a.txt", "from a\n", "add a");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "landed");
  assert.deepEqual(result?.landed, ["app"]);

  assert.equal((await landingRow(landing.id))!.status, "landed");
  const task = await taskRow(fx.task.id);
  assert.equal(task!.status, "done", "the landing finishes the leaf, not the planner's acceptance");
  assert.ok(task!.endedAt);

  // The branch really moved, and the commit is attributable to the leaf
  // through the trailer rather than through a sha nobody kept.
  assert.equal(await git(fx.swarmTree, ["show", "HEAD:a.txt"]), "from a");
  const commits = await commitsForTask(repoPath, `swarm/clean`, fx.task.id);
  assert.equal(commits.length, 1);

  // The leaf's machine is no longer able to do anything useful, so it is
  // queued for reaping by its own task id rather than the swarm's.
  assert.ok(
    queued.some((job) => job.queue === "sandbox.reap" && job.data.swarmTaskId === fx.task.id),
    "the worker's sandbox is asked for the moment its branch lands",
  );
  assert.ok(queued.some((job) => job.queue === "swarm.tick"));
});

test("running the same landing twice leaves one landing, which is what a restart does", async () => {
  const fx = await swarmWithLeaf("twice");
  await commitIn(fx.workerTree, fx.task.id, "b.txt", "from b\n", "add b");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const first = await performLanding(ctx, landing.id);
  assert.equal(first?.status, "landed");
  const head = await git(fx.swarmTree, ["rev-parse", "HEAD"]);

  /**
   * The row is no longer claimed, so a redelivered job reads it and
   * stops. This is the ordinary case: pg-boss delivers at least once.
   */
  const second = await performLanding(ctx, landing.id);
  assert.equal(second, null, "a landing that is over is not performed again");
  assert.equal(await git(fx.swarmTree, ["rev-parse", "HEAD"]), head);

  /**
   * And the case the ordering exists for: the server died after the
   * fast forward and before the row was written, so the row still says
   * "landing" and the branch has already moved. Re-running has to
   * finish the row rather than apply the work a second time.
   */
  await db.update(swarmLandings).set({ status: "landing" }).where(eq(swarmLandings.id, landing.id));
  const third = await performLanding(ctx, landing.id);
  assert.equal(third?.status, "landed", "the crashed landing completes");
  assert.equal(await git(fx.swarmTree, ["rev-parse", "HEAD"]), head, "and nothing was applied twice");
  assert.equal((await commitsForTask(repoPath, "swarm/twice", fx.task.id)).length, 1);
});

test("a conflict starts one resolver, holds the queue, and switches the leaf to merge", async () => {
  const fx = await swarmWithLeaf("conflict");

  // Another leaf already landed a change to the same lines, which is
  // the only conflict a swarm actually produces.
  await commitIn(fx.swarmTree, "00000000-0000-0000-0000-000000000000", "shared.txt", "one\nFROM OTHER\nthree\n", "other leaf");
  await commitIn(fx.workerTree, fx.task.id, "shared.txt", "one\nFROM MINE\nthree\n", "my leaf");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "conflicted");
  assert.ok(result?.resolverRunId, "an agent was put on it");

  const row = await landingRow(landing.id);
  assert.equal(row!.status, "conflicted", "which holds the queue: nothing may overtake a conflict");
  assert.equal(row!.resolverRunId, result!.resolverRunId);
  assert.match(row!.error ?? "", /conflict/i);

  const task = await taskRow(fx.task.id);
  assert.equal(task!.attention, "conflict");
  assert.equal(
    (task!.flags as { landPolicy?: string }).landPolicy,
    "merge",
    "the resolver puts the swarm's branch inside this branch, so the next landing is a merge",
  );

  // The resolver run is a real row on the leaf, started through
  // startRunIfIdle and handed to the queue.
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, result!.resolverRunId!));
  assert.equal(run!.role, "resolver");
  assert.equal(run!.swarmTaskId, fx.task.id);
  assert.ok(queued.some((job) => job.queue === "run.execute" && job.data.runId === run!.id));
});

test("a leaf whose resolver did not help fails, rather than being resolved forever", async () => {
  const fx = await swarmWithLeaf("giveup");
  await commitIn(fx.swarmTree, "00000000-0000-0000-0000-000000000000", "shared.txt", "one\nOTHER\nthree\n", "other leaf");
  await commitIn(fx.workerTree, fx.task.id, "shared.txt", "one\nMINE\nthree\n", "my leaf");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  await performLanding(ctx, landing.id);
  // The resolver ran and the branch still does not land: the queue tries
  // it once more and then gives the leaf to the planner.
  await db.update(swarmLandings).set({ status: "landing" }).where(eq(swarmLandings.id, landing.id));
  const second = await performLanding(ctx, landing.id);

  assert.equal(second?.status, "failed");
  assert.equal((await landingRow(landing.id))!.status, "failed");
  const task = await taskRow(fx.task.id);
  assert.equal(task!.status, "failed", "a failed leaf is what puts it in front of the planner");
  assert.equal(task!.attention, "conflict");
});

test("a landing for work somebody withdrew is cancelled rather than applied", async () => {
  const fx = await swarmWithLeaf("withdrawn");
  await commitIn(fx.workerTree, fx.task.id, "c.txt", "from c\n", "add c");
  await db.update(swarmTasks).set({ status: "cancelled" }).where(eq(swarmTasks.id, fx.task.id));
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);
  const head = await git(fx.swarmTree, ["rev-parse", "HEAD"]);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "cancelled");
  assert.equal(await git(fx.swarmTree, ["rev-parse", "HEAD"]), head, "nothing of a withdrawn leaf reaches the branch");
});

test("a worker that committed nothing lands as done with no commits", async () => {
  const fx = await swarmWithLeaf("empty");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "landed");
  assert.deepEqual(result?.landed, [], "no repository moved");
  assert.equal((await taskRow(fx.task.id))!.status, "done");
});

test("a landing that is not at the front of the queue is not performed", async () => {
  const fx = await swarmWithLeaf("queued");
  await commitIn(fx.workerTree, fx.task.id, "d.txt", "from d\n", "add d");
  const [row] = await db
    .insert(swarmLandings)
    .values({ swarmId: fx.swarm.id, taskId: fx.task.id, branchName: fx.branch, position: 0, status: "queued" })
    .returning();
  const head = await git(fx.swarmTree, ["rev-parse", "HEAD"]);

  assert.equal(await performLanding(ctx, row!.id), null);
  assert.equal(await git(fx.swarmTree, ["rev-parse", "HEAD"]), head);
});
