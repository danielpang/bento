import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  sandboxes,
  swarmLandings,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import type { AppContext } from "../../context.js";
import { EventBus, type BoardEvent } from "../../events.js";
import { loadEnv } from "../../env.js";
import { taskTrailer, workerBranchName } from "./branches.js";
import { tickSwarm } from "./coordinator.js";
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
    // Only the provider is read here, and only to refuse a driver that
    // keeps its checkouts inside the machine rather than on this host.
    driver: { provider: "docker" },
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

/** The latch that decides whether a leaf's news ever reaches a planner. */
const plannerToldAt = (task: typeof swarmTasks.$inferSelect) =>
  (task.flags as { plannerToldAt?: string }).plannerToldAt;

/**
 * Marks a leaf as one the planner has already been told about.
 *
 * Which is the state every leaf is in by the time a landing goes wrong:
 * the planner heard its report, accepted it, and the latch has been
 * standing ever since. A test that left the latch empty would pass
 * whether or not the failure path clears it.
 */
async function alreadyTold(taskId: string): Promise<void> {
  const row = await taskRow(taskId);
  await db
    .update(swarmTasks)
    .set({ flags: { ...row!.flags, plannerToldAt: "2026-01-01T00:00:00.000Z" } })
    .where(eq(swarmTasks.id, taskId));
}

/** Where this host keeps the git directory of the swarm's checkout. */
async function gitDirOf(tree: string): Promise<string> {
  return git(tree, ["rev-parse", "--absolute-git-dir"]);
}

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

test("a conflict holds the queue, switches the leaf to merge, and has one resolver put on it", async () => {
  const fx = await swarmWithLeaf("conflict");

  // Another leaf already landed a change to the same lines, which is
  // the only conflict a swarm actually produces.
  await commitIn(fx.swarmTree, "00000000-0000-0000-0000-000000000000", "shared.txt", "one\nFROM OTHER\nthree\n", "other leaf");
  await commitIn(fx.workerTree, fx.task.id, "shared.txt", "one\nFROM MINE\nthree\n", "my leaf");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "conflicted");

  const row = await landingRow(landing.id);
  assert.equal(row!.status, "conflicted", "which holds the queue: nothing may overtake a conflict");
  assert.match(row!.error ?? "", /conflict/i);

  const task = await taskRow(fx.task.id);
  assert.equal(task!.attention, "conflict");
  assert.equal(
    (task!.flags as { landPolicy?: string }).landPolicy,
    "merge",
    "the resolver puts the swarm's branch inside this branch, so the next landing is a merge",
  );

  /**
   * And the agent is put on it by the tick, which the landing asked
   * for. Started there rather than here because a start has to be
   * retried: a team with no agent hours left cannot start a resolver
   * this second and the queue must not end over it.
   */
  assert.ok(queued.some((job) => job.queue === "swarm.tick" && job.data.swarmId === fx.swarm.id));
  const ticked = await tickSwarm(ctx, fx.swarm.id);
  assert.equal(ticked?.resolverRunIds.length, 1, "one agent, on the conflict the queue is held by");
  const resolverRunId = ticked!.resolverRunIds[0]!;
  assert.equal((await landingRow(landing.id))!.resolverRunId, resolverRunId);

  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, resolverRunId));
  assert.equal(run!.role, "resolver");
  assert.equal(run!.swarmTaskId, fx.task.id);
  assert.ok(
    queued.some((job) => job.queue === "run.execute" && job.data.runId === resolverRunId),
    "and handed to the queue, because a run row with no job never starts",
  );

  // Asked for once. A second tick finds the resolver working and leaves
  // the row alone rather than paying for another agent on it.
  const again = await tickSwarm(ctx, fx.swarm.id);
  assert.deepEqual(again?.resolverRunIds, []);
  assert.equal((await landingRow(landing.id))!.resolverRunId, resolverRunId);
});

test("a leaf whose resolver did not help fails, and the planner is actually told", async () => {
  const fx = await swarmWithLeaf("giveup");
  await commitIn(fx.swarmTree, "00000000-0000-0000-0000-000000000000", "shared.txt", "one\nOTHER\nthree\n", "other leaf");
  await commitIn(fx.workerTree, fx.task.id, "shared.txt", "one\nMINE\nthree\n", "my leaf");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);
  await alreadyTold(fx.task.id);

  await performLanding(ctx, landing.id);
  /**
   * The whole loop, through the doors a real swarm uses: the tick puts
   * a resolver on the conflict, the resolver ends without reconciling
   * anything, and the tick that follows puts the branch back in front
   * of the queue. The landing that then fails is the one that gives the
   * leaf up.
   */
  const started = await tickSwarm(ctx, fx.swarm.id);
  const resolverRunId = started!.resolverRunIds[0]!;
  await db.update(agentRuns).set({ status: "succeeded" }).where(eq(agentRuns.id, resolverRunId));
  const promoted = await tickSwarm(ctx, fx.swarm.id);
  assert.equal(promoted?.landingId, landing.id);
  assert.equal(promoted?.landingPromoted, true, "the reconciled branch is tried again");
  const second = await performLanding(ctx, landing.id);

  assert.equal(second?.status, "failed");
  assert.equal((await landingRow(landing.id))!.status, "failed");
  const task = await taskRow(fx.task.id);
  assert.equal(task!.status, "failed", "a failed leaf is what puts it in front of the planner");
  assert.equal(task!.attention, "conflict");
  /**
   * And it is a failure the planner can see. The wake only carries
   * leaves whose latch is empty, so a leaf failed with the latch left
   * standing is filtered out of every future wake: the swarm would hold
   * a leaf nothing can move, with the one actor that could split or
   * abandon it never told.
   */
  assert.equal(plannerToldAt(task!), undefined, "the latch is cleared by the write that failed the leaf");
  const woken = await tickSwarm(ctx, fx.swarm.id);
  assert.ok(woken?.plannerRunId, "and the next tick really does wake the planner about it");
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
  // And its machine goes, for the reason a landed leaf's does: the
  // branch it holds is never going anywhere now.
  assert.ok(
    queued.some((job) => job.queue === "sandbox.reap" && job.data.swarmTaskId === fx.task.id),
    "a withdrawn leaf's sandbox is asked for too",
  );
});

test("a worker that committed nothing lands as done with no commits", async () => {
  const fx = await swarmWithLeaf("empty");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "landed");
  assert.deepEqual(result?.landed, [], "no repository moved");
  assert.equal((await taskRow(fx.task.id))!.status, "done");
});

test("a deployment whose driver holds the checkouts says so, rather than failing on a missing path", async () => {
  const fx = await swarmWithLeaf("sprite");
  await commitIn(fx.workerTree, fx.task.id, "e.txt", "from e\n", "add e");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);
  const head = await git(fx.swarmTree, ["rev-parse", "HEAD"]);

  const driver = (ctx as unknown as { driver: { provider: string } }).driver;
  const was = driver.provider;
  driver.provider = "sprite";
  try {
    const result = await performLanding(ctx, landing.id);
    assert.equal(result?.status, "failed");
    assert.match(result?.reason ?? "", /nothing has been lost/);
    assert.doesNotMatch(result?.reason ?? "", /ENOENT|fatal:/, "not a git message about a path nobody can act on");
  } finally {
    driver.provider = was;
  }
  assert.equal(await git(fx.swarmTree, ["rev-parse", "HEAD"]), head);
});

test("a swarm checkout somebody left dirty fails the leaf rather than looping", async () => {
  /**
   * The loop this closes was cheap to reach and expensive to have. The
   * planner's sandbox mounts the swarm's own checkout and a landing
   * runs each repository's test command in it, so a file left modified
   * there is ordinary. Git refuses the fast forward in words that match
   * no conflict pattern, the catch called every failure "the branch
   * moved", and the row went back to the queue for the next tick to
   * promote and refuse again: a tick, a land job and a handful of git
   * subprocesses per pass, for as long as the file stayed dirty.
   */
  const fx = await swarmWithLeaf("dirty");
  await commitIn(fx.workerTree, fx.task.id, "shared.txt", "one\nFROM MINE\nthree\n", "my leaf");
  await writeFile(path.join(fx.swarmTree, "shared.txt"), "one\nLEFT BEHIND BY A TEST RUN\nthree\n");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);
  await alreadyTold(fx.task.id);

  const result = await performLanding(ctx, landing.id);
  assert.equal(result?.status, "failed", "not queued: nothing about this gets better by being tried again");
  const row = await landingRow(landing.id);
  assert.equal(row!.status, "failed");
  assert.match(row!.error ?? "", /local changes/i, "and git's own words, which name the file");

  const task = await taskRow(fx.task.id);
  assert.equal(task!.status, "failed");
  assert.equal(task!.attention, "failed");
  assert.equal(plannerToldAt(task!), undefined);
  assert.ok((await tickSwarm(ctx, fx.swarm.id))?.plannerRunId, "the planner hears about it");
});

test("a landing the swarm's branch keeps refusing is retried, and then given up", async () => {
  /**
   * A git process holding the index lock in the swarm's checkout is the
   * failure a retry is for, so the first answer is the queue. What was
   * missing is the last answer: attempt was being written by the tick
   * and read by nothing, so there was no cap, no terminal state, and
   * the same two jobs went round for as long as the condition held.
   */
  const fx = await swarmWithLeaf("stuck");
  await commitIn(fx.workerTree, fx.task.id, "h.txt", "from h\n", "add h");
  const lock = path.join(await gitDirOf(fx.swarmTree), "index.lock");
  await writeFile(lock, "");
  try {
    const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);
    const early = await performLanding(ctx, landing.id);
    assert.equal(early?.status, "queued", "a locked checkout is somebody else's moment, not this branch's fault");
    assert.equal((await landingRow(landing.id))!.status, "queued");

    // The same landing, as the queue would promote it after five
    // attempts that all said the same thing.
    await db
      .update(swarmLandings)
      .set({ status: "landing", attempt: 5 })
      .where(eq(swarmLandings.id, landing.id));
    await alreadyTold(fx.task.id);
    const last = await performLanding(ctx, landing.id);
    assert.equal(last?.status, "failed", "the retries are bounded, so the loop ends");
    assert.match(last?.reason ?? "", /tried 5 times/);
    const task = await taskRow(fx.task.id);
    assert.equal(task!.status, "failed");
    assert.equal(plannerToldAt(task!), undefined);
    assert.ok((await tickSwarm(ctx, fx.swarm.id))?.plannerRunId, "and the planner is the one told");
  } finally {
    await rm(lock, { force: true });
  }
});

test("a landing another job already finished does not have its outcome written over", async () => {
  /**
   * Two jobs on one row, which is what a second machine booting mid
   * landing produces: resumeClaimedLandings queues a job for every row
   * that says "landing", and the first machine is still performing it.
   * The partial unique index has nothing to say about it, because it
   * refuses a second row in flight rather than a second job on one row.
   *
   * The interleaving is the real one rather than a contrived one. This
   * job fast forwards the branch and goes off to run the swarm's checks
   * in its sandbox, which is the longest thing a landing does; the
   * other job finishes while it is in there. The answer this one comes
   * back with is "the checks failed, send the leaf back to be worked",
   * and written unconditionally it takes a leaf that has landed and is
   * done and puts it back in front of a worker.
   */
  const fx = await swarmWithLeaf("raced");
  await commitIn(fx.workerTree, fx.task.id, "i.txt", "from i\n", "add i");
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  // A sandbox and a check to run in it, which is what puts this landing
  // inside the driver while the other job finishes.
  const [sandbox] = await db
    .insert(sandboxes)
    .values({ projectId: PROJECT, swarmId: fx.swarm.id, provider: "docker", externalId: "box-1", status: "ready" })
    .returning();
  await db.update(swarms).set({ sandboxId: sandbox!.id }).where(eq(swarms.id, fx.swarm.id));
  await pool.query(`update repositories set test_command = 'pnpm test' where project_id = $1`, [PROJECT]);

  const driver = ctx.driver as unknown as { exec?: unknown };
  driver.exec = () => ({
    async *[Symbol.asyncIterator]() {
      // The other job, finishing: the branch is in and the leaf is done.
      await db
        .update(swarmLandings)
        .set({ status: "landed", endedAt: new Date() })
        .where(eq(swarmLandings.id, landing.id));
      await db.update(swarmTasks).set({ status: "done" }).where(eq(swarmTasks.id, fx.task.id));
      yield { kind: "stderr" as const, data: "1 test failed\n" };
      yield { kind: "exit" as const, exitCode: 1 };
    },
  });
  try {
    const result = await performLanding(ctx, landing.id);
    assert.equal(result, null, "a job that no longer holds the row says nothing about it");
  } finally {
    delete driver.exec;
    await pool.query(`update repositories set test_command = null where project_id = $1`, [PROJECT]);
  }

  assert.equal((await landingRow(landing.id))!.status, "landed", "the winner's answer stands");
  const task = await taskRow(fx.task.id);
  assert.equal(task!.status, "done", "and a leaf that has landed is not sent back to be worked");
  assert.equal(task!.attention, null);
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

/* ---------------------------------------------------------------- *
 * Test before landing, actually executed.
 * ---------------------------------------------------------------- */

/**
 * The checks a landing runs, run for real.
 *
 * This is the part of the merge queue that had never once executed. It
 * needs a sandbox, and the reasoning was that no Docker here means no
 * sandbox, so only the branch where it returns null was ever taken.
 * That was too quick: the local process driver is a sandbox as far as
 * `ctx.driver.exec` is concerned, it runs commands in the workspace's
 * worktree, and it is what the other end to end suites already use. So
 * the swarm's own checkout is the sandbox's workdir, the repository's
 * check is a real command, and both outcomes below are the command
 * really running and really failing.
 *
 * The provider is set to the driver's own name rather than left at
 * "docker": the landing refuses "sprite" and nothing else, so this is
 * the honest label for what is executing.
 */
async function withLocalDriver<T>(run: () => Promise<T>): Promise<T> {
  const driver = ctx.driver as unknown as { provider: string; exec?: unknown };
  const wasProvider = driver.provider;
  const local = new LocalProcessDriver();
  driver.provider = "local-process";
  driver.exec = local.exec.bind(local);
  try {
    return await run();
  } finally {
    driver.provider = wasProvider;
    delete driver.exec;
  }
}

/**
 * The machine the checks run on: the swarm's own workspace, which is
 * where `repositoryPathIn(workdir, name)` finds each repository's
 * checkout, exactly as a provisioned sandbox would.
 */
async function giveSwarmASandbox(swarmId: string): Promise<void> {
  const workdir = ctx.worktrees.workspacePath(swarmWorkspaceKey(swarmId));
  const [sandbox] = await db
    .insert(sandboxes)
    .values({ projectId: PROJECT, swarmId, provider: "docker", externalId: `local-${swarmId}`, status: "ready", workdir })
    .returning();
  await db.update(swarms).set({ sandboxId: sandbox!.id }).where(eq(swarms.id, swarmId));
}

async function setCheck(command: string | null): Promise<void> {
  await pool.query(`update repositories set test_command = $2 where project_id = $1`, [PROJECT, command]);
}

test("a branch that passes the swarm's own checks lands, and the checks really ran", async () => {
  const fx = await swarmWithLeaf("checks-pass");
  await commitIn(fx.workerTree, fx.task.id, "totals.txt", "1\n", "add totals");
  await giveSwarmASandbox(fx.swarm.id);

  /**
   * The command leaves a trace of where and when it ran, which is the
   * only way to tell a check that passed from a check that was never
   * executed: both of them land the branch. What it records is the
   * commit the swarm's checkout was on, and the assertion is that this
   * is the fast forwarded head rather than the one before it. The
   * check has to see the leaf's work, because a leaf that passes alone
   * and breaks what landed before it is the whole reason a merge queue
   * runs anything at all.
   */
  const marker = path.join(dataDir, "checks-pass.ran");
  await setCheck(`git rev-parse HEAD > ${marker} && test -f totals.txt`);
  const before = await git(fx.swarmTree, ["rev-parse", "HEAD"]);
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await withLocalDriver(() => performLanding(ctx, landing.id));
  await setCheck(null);

  assert.equal(result?.status, "landed");
  assert.equal((await taskRow(fx.task.id))!.status, "done");
  const ran = (await readFile(marker, "utf8")).trim();
  const after = await git(fx.swarmTree, ["rev-parse", "HEAD"]);
  assert.notEqual(after, before, "the fast forward happened");
  assert.equal(ran, after, "and the check ran in the swarm's checkout, after it");
});

test("a branch whose checks fail goes back to be worked, carrying the output, and is not rolled back", async () => {
  /**
   * The other outcome, and the one with a decision in it. The swarm's
   * branch is deliberately left where the fast forward put it: between
   * the fast forward and this verdict another landing can have built
   * on it, and rolling back would discard work that landed cleanly.
   * The leaf goes back to a worker instead, with the failure as its
   * rejection, which is what the next agent on it reads.
   */
  const fx = await swarmWithLeaf("checks-fail");
  await commitIn(fx.workerTree, fx.task.id, "broken.txt", "nope\n", "add broken");
  await giveSwarmASandbox(fx.swarm.id);
  await alreadyTold(fx.task.id);
  await setCheck(`echo "totals_spec: 1 failed, 0 passed"; exit 3`);
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);

  const result = await withLocalDriver(() => performLanding(ctx, landing.id));
  await setCheck(null);

  assert.equal(result?.status, "failed");
  const row = await landingRow(landing.id);
  assert.equal(row!.status, "failed");
  assert.match(row!.error ?? "", /does not pass app's check/);
  assert.match(row!.error ?? "", /totals_spec: 1 failed, 0 passed/, "the runner's own words, not an exit code");

  const task = await taskRow(fx.task.id);
  assert.equal(task!.status, "assigned", "the leaf goes back to a worker rather than to a person");
  assert.equal(task!.attention, "failed");
  assert.equal(task!.report, null, "its old report is cleared, so the planner is not shown a stale one");
  const flags = task!.flags as { rejection?: string; accepted?: unknown };
  assert.match(flags.rejection ?? "", /totals_spec: 1 failed, 0 passed/);
  assert.equal(flags.accepted, undefined, "it is no longer an accepted leaf");
  assert.equal(plannerToldAt(task!), undefined, "and the planner will hear about it");

  // The branch keeps the work. This is the decision worth arguing with,
  // so it is asserted rather than assumed.
  assert.equal(
    await git(fx.swarmTree, ["show", "HEAD:broken.txt"]),
    "nope",
    "the swarm's branch is left where the fast forward put it",
  );
});

test("a swarm with no machine runs no checks and lands anyway", async () => {
  /**
   * Which is the path every deployment without a provisioned sandbox
   * takes, and the only one that used to be exercised. Kept, and kept
   * beside the two above so it is clear which of the three is which.
   */
  const fx = await swarmWithLeaf("checks-none");
  await commitIn(fx.workerTree, fx.task.id, "fine.txt", "fine\n", "add fine");
  await setCheck(`exit 1`);
  const landing = await queueLanding(fx.swarm.id, fx.task.id, fx.branch);
  const result = await withLocalDriver(() => performLanding(ctx, landing.id));
  await setCheck(null);
  assert.equal(result?.status, "landed", "no sandbox is not a reason to stop the merge queue");
});
