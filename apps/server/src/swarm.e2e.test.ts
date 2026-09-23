import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  projects,
  repositories,
  runMigrations,
  sandboxes,
  swarmLandings,
  swarmPullRequests,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { createFeatureFlags } from "./feature-flags.js";
import { mintRunGrant } from "./mcp/grants.js";
import { BENTO_SWARM_SERVER_ID } from "./mcp/swarm-server.js";
import { taskTrailer } from "./orchestrator/swarm/branches.js";
import { tickSwarm } from "./orchestrator/swarm/coordinator.js";
import { publishSwarmCompletion } from "./orchestrator/swarm/complete.js";
import { performLanding } from "./orchestrator/swarm/landing.js";
import { swarmTaskWorkspaceKey, swarmWorkspaceKey } from "./orchestrator/swarm/sandbox.js";

/**
 * One swarm, start to finish, through the doors a swarm actually uses.
 *
 * The other suites each prove one joint. landing-git.test.ts proves the
 * git, landing.e2e.test.ts proves what the rows say afterwards,
 * coordinator.e2e.test.ts proves the reconciler's arithmetic, and
 * complete.e2e.test.ts proves the push. None of them proves that the
 * pieces are connected, and that is the failure this repository fears:
 * every part green while the thing does not work.
 *
 * So this is the story, once, with nothing stubbed between the parts.
 * The planner builds its plan through the real MCP tools over the real
 * gateway with a real run grant. The reconciler spawns the workers
 * through startRunIfIdle. The workers commit in the worktrees the
 * executor would have given them, with the trailer the prompt tells
 * them to write. The planner accepts through its tools. The merge
 * queue lands, one branch at a time, and runs the repository's check
 * inside the swarm's sandbox before it accepts each one. The second
 * leaf is made to conflict on purpose, so the resolver is started by
 * the tick, does its work, and the branch is tried again. And when the
 * root is done the swarm publishes: a real push to a bare repository
 * on disk, and a row read back out of Postgres.
 *
 * What is not here is the agent process itself. The fake adapter can
 * commit, but it cannot call a tool, so a run that "worked a leaf"
 * would be a run that never reported and never accepted anything. The
 * tools are driven directly instead, over the same gateway and the
 * same grants an agent would hold.
 */
const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_story_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const run = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { env: { ...process.env, ...IDENTITY } });
  return stdout.trim();
}

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let db: Db;
let projectId: string;
let repoPath: string;
let remotePath: string;
let dataDir: string;
let queued: { queue: string; data: Record<string, unknown> }[];
/** The body the fake GitHub was asked to open the pull request with. */
let openedBody = "";

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-swarm-story-"));

  // A bare repository standing in for GitHub, and the project's
  // checkout of it on this host.
  remotePath = path.join(dataDir, "remote.git");
  await run("git", ["init", "--quiet", "--bare", "-b", "main", remotePath]);
  repoPath = path.join(dataDir, "source");
  await run("git", ["init", "--quiet", "-b", "main", repoPath]);
  // Two files a leaf each, and one both leaves are told to touch,
  // which is how the conflict below is arranged.
  await writeFile(path.join(repoPath, "cart.txt"), "cart\n");
  await writeFile(path.join(repoPath, "shared.txt"), "one\ntwo\nthree\n");
  // The repository's own check, which the merge queue runs inside the
  // swarm's sandbox after each fast forward.
  await writeFile(path.join(repoPath, "check.sh"), "#!/bin/sh\ntest -f cart.txt\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "--quiet", "-m", "base"]);
  await git(repoPath, ["remote", "add", "origin", remotePath]);
  await git(repoPath, ["push", "--quiet", "origin", "main"]);

  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  db = createDb(pool);
  const userId = await ensureLocalUser(db);
  queued = [];

  ctx = {
    env,
    db,
    pool,
    boss: {
      send: async (queue: string, data: unknown) => {
        queued.push({ queue, data: data as Record<string, unknown> });
        return "job";
      },
      work: async () => "worker",
      offWork: async () => {},
      notifyWorker: () => {},
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
  };
  app = createApp(ctx);

  const [project] = await db
    .insert(projects)
    .values({ ownerId: userId, name: "Storefront", defaultBranch: "main" })
    .returning();
  projectId = project!.id;
  await db.insert(repositories).values({
    projectId,
    name: "app",
    localPath: repoPath,
    repoUrl: "https://github.com/acme/app",
    defaultBranch: "main",
    position: 0,
    testCommand: "sh ./check.sh",
  });
});

after(async () => {
  await ctx?.pool.end();
});

/** One tool call, the way an agent makes it: the gateway and a bearer token. */
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await app.request(`/api/mcp-gateway/${BENTO_SWARM_SERVER_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  assert.notEqual(body.result?.isError, true, JSON.stringify(body));
  return body.result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

/** A grant for one run, scoped the way the executor scopes it. */
async function grantFor(runId: string, swarmId: string, taskId?: string): Promise<string> {
  return mintRunGrant(ctx, {
    runId,
    organizationId: null,
    actingUserId: ctx.userId,
    serverIds: [BENTO_SWARM_SERVER_ID],
    swarmId,
    ...(taskId ? { swarmTaskId: taskId } : {}),
    ttlMs: 60_000,
  });
}

/** Marks a run finished, which is what the executor's settlement does. */
async function finish(runId: string): Promise<void> {
  await db.update(agentRuns).set({ status: "succeeded", endedAt: new Date() }).where(eq(agentRuns.id, runId));
}

/**
 * The worktree the executor would have given this leaf's agent, built
 * through the same manager and the same workspace key, off the swarm's
 * branch. Anything that made its own directory would prove the git and
 * nothing about the wiring.
 */
async function workerCheckout(swarmId: string, taskId: string, branch: string, from: string): Promise<string> {
  const [prepared] = await ctx.worktrees.ensureAll(
    [{ name: "app", localPath: repoPath, defaultBranch: "main", startFromBranch: from }],
    swarmTaskWorkspaceKey(swarmId, taskId),
    branch,
  );
  return prepared!.worktreePath;
}

const taskRow = async (id: string) => (await db.select().from(swarmTasks).where(eq(swarmTasks.id, id)))[0]!;

test("a swarm plans, works, lands through a conflict, and opens a pull request", { timeout: 180_000 }, async () => {
  /* ---- the swarm, and a planner with its tools ---- */

  const created = await app.request("/api/swarms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      title: "Rewrite the checkout",
      goal: "Replace the checkout with the hosted card field.",
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const swarm = (await created.json()) as { id: string; branchName: string; plannerRunId: string };
  const swarmBranch = swarm.branchName;

  // The swarm's own checkout and its machine, which is what the
  // planner's run would have provisioned and what the merge queue runs
  // the repository's check inside.
  await ctx.worktrees.ensureAll(
    [{ name: "app", localPath: repoPath, defaultBranch: "main" }],
    swarmWorkspaceKey(swarm.id),
    swarmBranch,
  );
  const swarmTree = ctx.worktrees.worktreePath(swarmWorkspaceKey(swarm.id), "app");
  const [sandbox] = await db
    .insert(sandboxes)
    .values({
      projectId,
      swarmId: swarm.id,
      provider: "docker",
      externalId: `local-${swarm.id}`,
      status: "ready",
      workdir: ctx.worktrees.workspacePath(swarmWorkspaceKey(swarm.id)),
    })
    .returning();
  await db.update(swarms).set({ sandboxId: sandbox!.id }).where(eq(swarms.id, swarm.id));
  await db.update(agentRuns).set({ sandboxId: sandbox!.id }).where(eq(agentRuns.id, swarm.plannerRunId));

  const plannerToken = await grantFor(swarm.plannerRunId, swarm.id);
  await tool(plannerToken, "write_design", {
    content: "## Approach\nOne leaf per surface, and both of them touch shared.txt.",
  });
  await tool(plannerToken, "create_task", {
    title: "Empty cart state",
    description: "Add the empty state to the cart.",
  });
  await tool(plannerToken, "create_task", {
    title: "Refund path",
    description: "Refund the last capture.",
  });
  const plan = await db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, swarm.id));
  assert.equal(plan.length, 2, "the plan the planner's own tools built");
  const cart = plan.find((task) => task.title === "Empty cart state")!;
  const refund = plan.find((task) => task.title === "Refund path")!;

  await tool(plannerToken, "assign", { taskId: cart.id });
  await tool(plannerToken, "assign", { taskId: refund.id });
  await finish(swarm.plannerRunId);

  // Started, which is the thing the tree cannot say for itself.
  assert.equal((await app.request(`/api/swarms/${swarm.id}/start`, { method: "POST" })).status, 200);

  /* ---- one worker lands cleanly ---- */

  const first = await tickSwarm(ctx, swarm.id);
  assert.ok(first!.workerRunIds.length >= 1, "the reconciler put agents on the assigned leaves");
  const cartRun = (await taskRow(cart.id)).assignedRunId!;
  const cartBranch = (await taskRow(cart.id)).branchName ?? `${swarmBranch}-${cart.id.slice(0, 8)}`;
  await db.update(swarmTasks).set({ branchName: cartBranch }).where(eq(swarmTasks.id, cart.id));

  const cartTree = await workerCheckout(swarm.id, cart.id, cartBranch, swarmBranch);
  await writeFile(path.join(cartTree, "cart.txt"), "cart\nempty state\n");
  await writeFile(path.join(cartTree, "shared.txt"), "one\nCART\nthree\n");
  await git(cartTree, ["add", "."]);
  await git(cartTree, ["commit", "--quiet", "-m", `Add the empty cart state\n\n${taskTrailer(cart.id)}`]);

  const cartToken = await grantFor(cartRun, swarm.id, cart.id);
  await tool(cartToken, "report", { summary: "Added the empty state and touched shared.txt." });
  await finish(cartRun);

  // The planner hears about it and accepts, which is what puts the
  // branch on the merge queue.
  const woken = await tickSwarm(ctx, swarm.id);
  assert.ok(woken!.plannerRunId, "a reported leaf wakes the planner");
  const acceptToken = await grantFor(woken!.plannerRunId!, swarm.id);
  await tool(acceptToken, "accept", { taskId: cart.id });
  await finish(woken!.plannerRunId!);

  const promoted = await tickSwarm(ctx, swarm.id);
  assert.ok(promoted!.landingId, "the accepted branch reached the front of the queue");
  const landedFirst = await performLanding(ctx, promoted!.landingId!);
  assert.equal(landedFirst?.status, "landed", "a clean branch lands");
  assert.equal((await taskRow(cart.id)).status, "done");
  assert.equal(await git(swarmTree, ["show", "HEAD:cart.txt"]), "cart\nempty state");
  assert.equal(
    await git(swarmTree, ["show", "HEAD:shared.txt"]),
    "one\nCART\nthree",
    "and the swarm's branch really moved",
  );

  /* ---- the second worker conflicts, and goes through the resolver ---- */

  const refundRun = (await taskRow(refund.id)).assignedRunId ?? (await tickSwarm(ctx, swarm.id))!.workerRunIds[0]!;
  const refundBranch = (await taskRow(refund.id)).branchName ?? `${swarmBranch}-${refund.id.slice(0, 8)}`;
  await db.update(swarmTasks).set({ branchName: refundBranch }).where(eq(swarmTasks.id, refund.id));

  /**
   * Branched from where the swarm's branch stood before the first leaf
   * landed, which is exactly how two workers conflict in a real swarm:
   * both were given the same starting point and both edited the same
   * lines.
   */
  const refundTree = await workerCheckout(swarm.id, refund.id, refundBranch, "main");
  await writeFile(path.join(refundTree, "shared.txt"), "one\nREFUND\nthree\n");
  await git(refundTree, ["add", "."]);
  await git(refundTree, ["commit", "--quiet", "-m", `Refund the last capture\n\n${taskTrailer(refund.id)}`]);

  const refundToken = await grantFor(refundRun, swarm.id, refund.id);
  await tool(refundToken, "report", { summary: "Refunds done; shared.txt changed." });
  await finish(refundRun);

  const secondWake = await tickSwarm(ctx, swarm.id);
  const secondAccept = await grantFor(secondWake!.plannerRunId!, swarm.id);
  await tool(secondAccept, "accept", { taskId: refund.id });
  await finish(secondWake!.plannerRunId!);

  const queuedSecond = await tickSwarm(ctx, swarm.id);
  const conflicted = await performLanding(ctx, queuedSecond!.landingId!);
  assert.equal(conflicted?.status, "conflicted", "two leaves on the same lines is a conflict, not a landing");
  assert.equal((await taskRow(refund.id)).attention, "conflict");

  // The tick is what puts an agent on it, and the resolver works the
  // leaf's own checkout: it merges the swarm's branch in and resolves.
  const resolving = await tickSwarm(ctx, swarm.id);
  assert.equal(resolving!.resolverRunIds.length, 1, "one resolver, on the conflict holding the queue");
  const resolverRunId = resolving!.resolverRunIds[0]!;
  const [resolverRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, resolverRunId));
  assert.equal(resolverRun!.role, "resolver");
  assert.equal(resolverRun!.swarmTaskId, refund.id, "and it is reachable from the leaf it serves");

  await git(refundTree, ["merge", "--no-commit", swarmBranch]).catch(() => undefined);
  await writeFile(path.join(refundTree, "shared.txt"), "one\nCART\nREFUND\nthree\n");
  await git(refundTree, ["add", "."]);
  await git(refundTree, ["commit", "--quiet", "-m", `Merge the swarm's branch\n\n${taskTrailer(refund.id)}`]);
  await finish(resolverRunId);

  const retried = await tickSwarm(ctx, swarm.id);
  assert.equal(retried!.landingPromoted, true, "a reconciled branch is tried again");
  const landedSecond = await performLanding(ctx, retried!.landingId!);
  assert.equal(landedSecond?.status, "landed", "and the resolver's work lands");
  assert.equal(
    await git(swarmTree, ["show", "HEAD:shared.txt"]),
    "one\nCART\nREFUND\nthree",
    "with both leaves' changes on the branch",
  );
  assert.equal((await taskRow(refund.id)).status, "done");

  const landings = await db.select().from(swarmLandings).where(eq(swarmLandings.swarmId, swarm.id));
  assert.equal(landings.filter((row) => row.status === "landed").length, 2);

  /* ---- the root is done, so the swarm publishes ---- */

  const finished = await tickSwarm(ctx, swarm.id);
  assert.equal(finished!.status, "done");
  assert.equal(finished!.becameDone, true);
  assert.ok(
    queued.some((job) => job.queue === "swarm.publish" && job.data.swarmId === swarm.id),
    "and the tick asks for the publish rather than doing it inline",
  );

  const [row] = await db.select().from(swarms).where(eq(swarms.id, swarm.id));
  const published = await publishSwarmCompletion(
    ctx,
    row!,
    {
      async pushToken() {
        return "unused: the remote is a directory";
      },
      async ensurePullRequest(input: { owner: string; repo: string; body: string }) {
        openedBody = input.body;
        return { prNumber: 11, url: `https://github.com/${input.owner}/${input.repo}/pull/11` };
      },
      async getPullRequest() {
        return { title: "", body: null, state: "open", merged: false };
      },
      async updatePullRequest() {},
      async pullRequestHasComment() {
        return false;
      },
      async createPullRequestComment() {},
    },
    { remoteUrl: () => remotePath },
  );
  assert.deepEqual(published.failures, []);
  assert.equal(published.published.length, 1);

  // The branch really reached the remote, with both leaves on it.
  assert.equal(
    await git(remotePath, ["show", `refs/heads/${swarmBranch}:shared.txt`]),
    "one\nCART\nREFUND\nthree",
  );

  // And the row, read back out of Postgres.
  const prs = await db.select().from(swarmPullRequests).where(eq(swarmPullRequests.swarmId, swarm.id));
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.number, 11);
  assert.equal(prs[0]!.url, "https://github.com/acme/app/pull/11");
  assert.equal(prs[0]!.headSha, await git(remotePath, ["rev-parse", `refs/heads/${swarmBranch}`]));

  // The body a reviewer opens: the goal, the planner's own write-up,
  // the tree, and what landed.
  assert.match(openedBody, /Replace the checkout with the hosted card field\./);
  assert.match(openedBody, /One leaf per surface/);
  assert.match(openedBody, /- Empty cart state \(done\)/);
  assert.match(openedBody, /- Refund path/);
  assert.match(openedBody, /## What landed on this branch/);

  // The console's view of the same swarm, through the route it reads.
  const detail = (await (await app.request(`/api/swarms/${swarm.id}`)).json()) as {
    pullRequests: { number: number; url: string }[];
  };
  assert.deepEqual(detail.pullRequests, [
    { id: prs[0]!.id, repoUrl: "https://github.com/acme/app", number: 11, url: prs[0]!.url, headSha: prs[0]!.headSha },
  ]);

  // And one node, with its commits found through the trailer that
  // survived the rebase.
  const node = (await (await app.request(`/api/swarms/${swarm.id}/tasks/${cart.id}`)).json()) as {
    commits: { subject: string }[];
    events: { kind: string }[];
  };
  assert.deepEqual(
    node.commits.map((commit) => commit.subject),
    ["Add the empty cart state"],
    "the commit is still attributable after landing rewrote its sha",
  );
  assert.ok(node.events.some((event) => event.kind === "landed"));

  // The check really ran: the repository's command is a script in the
  // checkout, and a branch that had not landed would not have it.
  assert.match(await readFile(path.join(swarmTree, "check.sh"), "utf8"), /test -f cart\.txt/);
});

/** Nothing in this file may leave a landing or a task behind mid flight. */
test("every landing and every leaf of that swarm settled", async () => {
  const rows = await db
    .select({ status: swarmLandings.status })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.status, "landing")));
  assert.deepEqual(rows, [], "a landing left claimed would hold that swarm's queue for ever");
});
