import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import {
  createDb,
  createPool,
  agentProfiles,
  agentRuns,
  features,
  pipelines,
  projects,
  repositories,
  runArtifacts,
  runMigrations,
  sandboxes,
  stages,
  swarmLandings,
  swarmTasks,
  swarms,
} from "@bento/db";
import { WorktreeManager, type SandboxDriver } from "@bento/sandbox";
import { singleDriver } from "./sandbox-driver.js";
import pg from "pg";
import { DiskArtifactStore } from "../artifact-store.js";
import { artifactStorageKey } from "./capture-artifacts.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { SecretBox } from "../secrets.js";
import { EventBus } from "../events.js";
import {
  FAILED_SWARM_MACHINE_GRACE_MS,
  MAX_SANDBOX_REAP_DEFERRALS,
  SANDBOX_REAP_DEFER_MS,
  SandboxReapDeferred,
  reapFinishedSandboxes,
  reapFinishedSwarmSandboxes,
  reapSandbox,
  reapSwarmSandbox,
  reapSwarmTaskSandbox,
  runSandboxReapJob,
  swarmMachineReleasable,
} from "./reap-sandbox.js";
import { swarmReleasesMachine } from "./swarm/coordinator.js";
import { swarmWorkspaceKey } from "./swarm/sandbox.js";

const run = promisify(execFile);

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "reap_sandbox_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let repoDir: string;
const destroyed: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function fixtureRepo(): Promise<string> {
  const dir = await scratchDir("bento-reap-repo-");
  await run("git", ["-C", dir, "init", "-qb", "main"]);
  await writeFile(path.join(dir, "README.md"), "fixture\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  repoDir = await fixtureRepo();
  const dataDir = await scratchDir("bento-reap-data-");
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const userId = await ensureLocalUser(db);

  ctx = {
    env,
    db,
    pool,
    boss: { send: async () => "job" } as AppContext["boss"],
    bus: new EventBus(),
    drivers: singleDriver({
      provider: "docker",
      workspace: "host",
      async destroy(handle: { externalId: string }) {
        destroyed.push(handle.externalId);
      },
      async exists() {
        return false;
      },
    } as unknown as SandboxDriver),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  };
});

after(async () => {
  await ctx.pool.end();
});

async function seedCard(opts: {
  title: string;
  status?: "backlog" | "active" | "done" | "cancelled";
  sandbox?: boolean;
}): Promise<{
  featureId: string;
  projectId: string;
  stageId: string;
  branch: string;
  repos: { name: string; localPath: string }[];
}> {
  const featureId = randomUUID();
  const branch = `feature/${featureId}`;
  const [project] = await ctx.db
    .insert(projects)
    .values({ ownerId: ctx.userId, name: opts.title, localPath: repoDir })
    .returning();
  const [pipeline] = await ctx.db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "Default", isDefault: true })
    .returning();
  const [stage] = await ctx.db
    .insert(stages)
    .values({
      pipelineId: pipeline!.id,
      position: 0,
      name: "Implementation",
      slug: "implementation",
    })
    .returning();
  await ctx.db.insert(repositories).values({
    projectId: project!.id,
    name: "app",
    localPath: repoDir,
  });
  await ctx.db.insert(features).values({
    id: featureId,
    projectId: project!.id,
    pipelineId: pipeline!.id,
    title: opts.title,
    status: opts.status ?? "done",
    branchName: branch,
  });
  if (opts.sandbox !== false) {
    await ctx.db.insert(sandboxes).values({
      projectId: project!.id,
      featureId,
      provider: "docker",
      externalId: `box-${featureId}`,
      status: "ready",
      workdir: "/workspace",
    });
  }
  const repos = [{ name: "app", localPath: repoDir }];
  await ctx.worktrees.ensureAll(repos, featureId, branch);
  return { featureId, projectId: project!.id, stageId: stage!.id, branch, repos };
}

async function seedSucceededRun(featureId: string, stageId: string) {
  const [profile] = await ctx.db
    .insert(agentProfiles)
    .values({
      ownerId: ctx.userId,
      name: `agent-${featureId}`,
      cli: "fake",
      model: "fake-1",
    })
    .returning();
  const [row] = await ctx.db
    .insert(agentRuns)
    .values({
      type: "pipeline",
      featureId,
      stageId,
      agentProfileId: profile!.id,
      prompt: "do the work",
      status: "succeeded",
    })
    .returning();
  return row!;
}

/**
 * A swarm and the machine it works in, which is not a card's.
 *
 * `featureId` is null on it, which is the whole reason the sweep used
 * to miss every one of them, and `swarmTaskId` is null because this is
 * the swarm's own machine rather than a leaf's worker.
 */
async function seedSwarm(opts: {
  title: string;
  status: (typeof swarms.$inferSelect)["status"];
  run?: "running" | "succeeded";
}): Promise<{ swarmId: string; sandboxId: string; externalId: string }> {
  const [project] = await ctx.db
    .insert(projects)
    .values({ ownerId: ctx.userId, name: opts.title, localPath: repoDir })
    .returning();
  const [swarm] = await ctx.db
    .insert(swarms)
    .values({
      workerIsolation: "worktree",
      projectId: project!.id,
      slug: `s-${randomUUID().slice(0, 8)}`,
      title: opts.title,
      status: opts.status,
    })
    .returning();
  const externalId = `swarm-box-${swarm!.id}`;
  const [sandbox] = await ctx.db
    .insert(sandboxes)
    .values({
      projectId: project!.id,
      swarmId: swarm!.id,
      provider: "docker",
      externalId,
      status: "ready",
      workdir: "/workspace",
    })
    .returning();
  if (opts.run) {
    const [profile] = await ctx.db
      .insert(agentProfiles)
      .values({ ownerId: ctx.userId, name: `planner-${swarm!.id}`, cli: "fake", model: "fake-1" })
      .returning();
    await ctx.db.insert(agentRuns).values({
      type: "swarm",
      swarmId: swarm!.id,
      role: "planner",
      agentProfileId: profile!.id,
      prompt: "plan it",
      status: opts.run,
    });
  }
  return { swarmId: swarm!.id, sandboxId: sandbox!.id, externalId };
}

/**
 * The remaining local-mode leak: the container is already reclaimed, but
 * the host workspace (worktrees plus leftover node_modules) sat around
 * after the card was marked done. Reaping has to take that too, without
 * touching the artifacts that capture already stored outside the sandbox.
 */
test("reaping a finished card destroys its machine and workspace, and leaves artifacts", async () => {
  const { featureId, stageId } = await seedCard({ title: "Done card" });
  const worktreePath = ctx.worktrees.worktreePath(featureId, "app");
  await mkdir(path.join(ctx.worktrees.workspacePath(featureId), "node_modules"), { recursive: true });
  await writeFile(path.join(worktreePath, "WIP.md"), "uncommitted\n");

  const runRow = await seedSucceededRun(featureId, stageId);
  const [textArt] = await ctx.db
    .insert(runArtifacts)
    .values({
      type: "pipeline",
      runId: runRow.id,
      featureId,
      stageSlug: "implementation",
      stageName: "Implementation",
      path: "docs/bento/implementation.md",
      kind: "markdown",
      mime: "text/markdown",
      size: 12,
      content: "# write-up\n",
    })
    .returning();
  const storageKey = artifactStorageKey(null, { featureId }, runRow.id, "shot");
  await ctx.artifacts!.put(storageKey, Buffer.from("png-bytes"), "image/png");
  await ctx.db.insert(runArtifacts).values({
    type: "pipeline",
    runId: runRow.id,
    featureId,
    stageSlug: "implementation",
    stageName: "Implementation",
    path: "artifacts/shot.png",
    kind: "image",
    mime: "image/png",
    size: 9,
    storageKey,
  });

  await reapSandbox(ctx, featureId);

  const [sandbox] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  assert.equal(sandbox?.status, "destroyed");
  assert.ok(destroyed.includes(`box-${featureId}`), "the driver was asked to destroy the machine");
  await assert.rejects(() => stat(ctx.worktrees.workspacePath(featureId)), { code: "ENOENT" });
  const { stdout } = await run("git", ["-C", repoDir, "worktree", "list", "--porcelain"]);
  assert.equal(stdout.includes(worktreePath), false, "the origin no longer lists the worktree");

  const artifacts = await ctx.db.select().from(runArtifacts).where(eq(runArtifacts.featureId, featureId));
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts.find((row) => row.id === textArt!.id)?.content, "# write-up\n");
  assert.deepEqual(await ctx.artifacts!.get(storageKey), Buffer.from("png-bytes"));

  await reapSandbox(ctx, featureId);
  assert.equal((await ctx.db.select().from(runArtifacts).where(eq(runArtifacts.featureId, featureId))).length, 2);
  assert.deepEqual(await ctx.artifacts!.get(storageKey), Buffer.from("png-bytes"));
});

test("a feature with worktrees but no sandbox row still loses its workspace", async () => {
  const { featureId } = await seedCard({ title: "Never provisioned", sandbox: false });
  await reapSandbox(ctx, featureId);
  await assert.rejects(() => stat(ctx.worktrees.workspacePath(featureId)), { code: "ENOENT" });
});

test("an active run refuses the reap and leaves the workspace", async () => {
  const { featureId, stageId } = await seedCard({ title: "Still working", status: "active" });
  const [profile] = await ctx.db
    .insert(agentProfiles)
    .values({
      ownerId: ctx.userId,
      name: `busy-${featureId}`,
      cli: "fake",
      model: "fake-1",
    })
    .returning();
  await ctx.db.insert(agentRuns).values({
    type: "pipeline",
    featureId,
    stageId,
    agentProfileId: profile!.id,
    prompt: "still going",
    status: "running",
  });

  await assert.rejects(() => reapSandbox(ctx, featureId), /still working/);
  await stat(ctx.worktrees.workspacePath(featureId));
  const [sandbox] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  assert.equal(sandbox?.status, "ready");
});

test("reaping then ensuring the worktree again keeps the committed history", async () => {
  const { featureId, branch, repos } = await seedCard({ title: "Reopen me" });
  const worktreePath = ctx.worktrees.worktreePath(featureId, "app");
  await writeFile(path.join(worktreePath, "kept.md"), "committed work\n");
  await run("git", ["-C", worktreePath, "add", "-A"]);
  await run("git", [
    "-C",
    worktreePath,
    "-c",
    "user.email=t@t.test",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "keep this",
  ]);
  const { stdout: sha } = await run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);

  await reapSandbox(ctx, featureId);
  await assert.rejects(() => stat(worktreePath), { code: "ENOENT" });
  const [again] = await ctx.worktrees.ensureAll(repos, featureId, branch);
  const { stdout: head } = await run("git", ["-C", again!.worktreePath, "rev-parse", "HEAD"]);
  assert.equal(head.trim(), sha.trim());
});

/**
 * Cards finished before workspace cleanup existed keep their directories
 * forever unless the boot sweep looks at the worktrees folder itself.
 * Active cards and names that are not feature ids stay put.
 */
test("the boot sweep reclaims leftover workspaces of finished and deleted cards", async () => {
  const done = await seedCard({ title: "Sweep done", sandbox: false });
  const cancelled = await seedCard({ title: "Sweep cancelled", status: "cancelled", sandbox: false });
  const active = await seedCard({ title: "Sweep active", status: "active", sandbox: false });
  const deleted = await seedCard({ title: "Sweep deleted", sandbox: false });
  await ctx.db.delete(features).where(eq(features.id, deleted.featureId));

  const junk = path.join(ctx.env.BENTO_DATA_DIR, "worktrees", "not-a-uuid");
  await mkdir(junk, { recursive: true });
  await writeFile(path.join(junk, "keep.txt"), "leave me\n");

  /**
   * A swarm's workspace shares this folder and is not a card.
   *
   * The sweep deletes a directory whose row it cannot find, and a
   * swarm has no row in features, so a pattern that accepted
   * `swarm-<id>` would delete the workspace of a swarm that is still
   * working. The prefix is what keeps it out, and this is what says so.
   */
  const swarmWorkspace = path.join(
    ctx.env.BENTO_DATA_DIR,
    "worktrees",
    swarmWorkspaceKey("2f1c9d1e-3b7a-4c55-9f0e-6d2a8b4c1e77"),
  );
  await mkdir(swarmWorkspace, { recursive: true });
  await writeFile(path.join(swarmWorkspace, "leaf.txt"), "still working\n");

  await reapFinishedSandboxes(ctx);

  await assert.rejects(() => stat(ctx.worktrees.workspacePath(done.featureId)), { code: "ENOENT" });
  await assert.rejects(() => stat(ctx.worktrees.workspacePath(cancelled.featureId)), { code: "ENOENT" });
  await assert.rejects(() => stat(ctx.worktrees.workspacePath(deleted.featureId)), { code: "ENOENT" });
  await stat(ctx.worktrees.workspacePath(active.featureId));
  await stat(path.join(junk, "keep.txt"));
  await stat(path.join(swarmWorkspace, "leaf.txt"));
});

/**
 * A swarm's own machine costs money the same way a card's does.
 *
 * It is the longest lived machine in the product: provisioned before
 * the plan exists, still there when the last leaf lands. The sweep
 * reached it through a join on features, and a swarm machine has no
 * feature, so an inner join matched none of them: every swarm anybody
 * ever finished or stopped left its sprite running and billing, and
 * only deleting the swarm outright took it.
 */
test("the boot sweep reclaims the machine of a swarm that is over, and leaves a live one", async () => {
  const stopped = await seedSwarm({ title: "Swarm stopped", status: "cancelled" });
  const finished = await seedSwarm({ title: "Swarm done", status: "done" });
  const live = await seedSwarm({ title: "Swarm running", status: "running" });

  await reapFinishedSandboxes(ctx);

  for (const over of [stopped, finished]) {
    assert.ok(destroyed.includes(over.externalId), `the driver was asked to destroy ${over.externalId}`);
    const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, over.sandboxId));
    assert.equal(row?.status, "destroyed", "and the row says the machine is gone");
  }
  assert.equal(destroyed.includes(live.externalId), false, "a swarm still working keeps its machine");
  const [running] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, live.sandboxId));
  assert.equal(running?.status, "ready");
});

/**
 * A failed swarm is the one a person retries, and its machine is the
 * only copy of every leaf that landed. Production lost a swarm's
 * landed work to this sweep; now it waits out a week untouched.
 */
test("the boot sweep keeps a failed swarm's machine until it has sat untouched past its grace", async () => {
  const recent = await seedSwarm({ title: "Swarm failed today", status: "failed" });
  const abandoned = await seedSwarm({ title: "Swarm failed long ago", status: "failed" });
  await ctx.db
    .update(swarms)
    .set({ updatedAt: new Date(Date.now() - FAILED_SWARM_MACHINE_GRACE_MS - 60_000) })
    .where(eq(swarms.id, abandoned.swarmId));

  await reapFinishedSwarmSandboxes(ctx);

  assert.equal(destroyed.includes(recent.externalId), false, "a retry can still land onto it");
  const [kept] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, recent.sandboxId));
  assert.equal(kept?.status, "ready");
  assert.ok(destroyed.includes(abandoned.externalId), "a week untouched is a swarm nobody is coming back to");
  const [gone] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, abandoned.sandboxId));
  assert.equal(gone?.status, "destroyed");
});

test("a swarm's machine is not taken out from under an agent still working in it", async () => {
  const swarm = await seedSwarm({ title: "Swarm with an agent", status: "cancelled", run: "running" });
  await assert.rejects(
    () => reapSwarmSandbox(ctx, swarm.swarmId),
    (err: unknown) => {
      assert.ok(err instanceof SandboxReapDeferred);
      assert.match(err.message, /still working/);
      assert.equal(err.reap.swarmId, swarm.swarmId);
      return true;
    },
  );
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
  assert.equal(row?.status, "ready", "the row still points at a machine that is there");
});

/**
 * The refusal used to fail the reap job, and every retry was an error.
 *
 * A swarm that has ended can still have an agent in its machine: a
 * stopped swarm's run is marked cancelled by a compare and set that a
 * run on another process may not have seen yet. The job has to come
 * back or the machine is leaked, and it has to come back without being
 * a failure or error tracking records the wait. (A failed swarm is no
 * longer reaped at all, so these use a cancelled one.)
 */
test("a reap job asked while an agent is still working comes back later instead of failing", async () => {
  const swarm = await seedSwarm({ title: "Swarm job waits", status: "cancelled", run: "running" });
  const sent: { data: unknown; options?: { startAfter?: Date } }[] = [];
  const previous = ctx.boss;
  ctx.boss = {
    send: async (_queue: string, data: unknown, options?: { startAfter?: Date }) => {
      sent.push({ data, ...(options ? { options } : {}) });
      return "job";
    },
  } as AppContext["boss"];
  try {
    await runSandboxReapJob(ctx, { swarmId: swarm.swarmId });
  } finally {
    ctx.boss = previous;
  }
  assert.equal(destroyed.includes(swarm.externalId), false, "the machine is not destroyed");
  assert.equal(sent.length, 1, "the same reap is asked for again");
  assert.deepEqual(sent[0]?.data, { swarmId: swarm.swarmId, deferrals: 1 });
  const when = sent[0]?.options?.startAfter;
  assert.ok(when instanceof Date, "it waits, rather than running again immediately");
  const delay = when.getTime() - Date.now();
  assert.ok(delay > SANDBOX_REAP_DEFER_MS - 5_000 && delay < SANDBOX_REAP_DEFER_MS + 5_000);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
  assert.equal(row?.status, "ready");
});

test("a reap job that has waited its fill fails rather than waiting forever", async () => {
  const swarm = await seedSwarm({ title: "Swarm run stuck", status: "cancelled", run: "running" });
  const sent: unknown[] = [];
  const previous = ctx.boss;
  ctx.boss = {
    send: async (_queue: string, data: unknown) => {
      sent.push(data);
      return "job";
    },
  } as AppContext["boss"];
  try {
    // One wait short of the bound still waits.
    await runSandboxReapJob(ctx, { swarmId: swarm.swarmId, deferrals: MAX_SANDBOX_REAP_DEFERRALS - 1 });
    assert.equal(sent.length, 1);
    // At the bound, a run still active is a run that is stuck, and
    // the job fails so the wait is recorded once.
    await assert.rejects(
      () => runSandboxReapJob(ctx, { swarmId: swarm.swarmId, deferrals: MAX_SANDBOX_REAP_DEFERRALS }),
      /still working/,
    );
    assert.equal(sent.length, 1, "and nothing more is queued");
  } finally {
    ctx.boss = previous;
  }
  assert.equal(destroyed.includes(swarm.externalId), false, "the machine is never destroyed under the agent");
});

test("a reap job still fails when the machine survives being destroyed", async () => {
  const swarm = await seedSwarm({ title: "Swarm machine stuck", status: "done" });
  const previous = ctx.drivers;
  ctx.drivers = singleDriver({
    provider: "docker",
    workspace: "host",
    async destroy() {},
    async exists() {
      return true;
    },
  } as unknown as SandboxDriver);
  try {
    await assert.rejects(() => runSandboxReapJob(ctx, { swarmId: swarm.swarmId }), /still there/);
  } finally {
    ctx.drivers = previous;
  }
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
  assert.equal(row?.status, "ready", "a machine that survived is not recorded as gone");
});

/**
 * One card can hold two machines when the driver was switched or a
 * rebuild left the older container. A row this process cannot drive
 * must not abort the rest, and must not be marked destroyed.
 */
test("an unconfigured sandbox row does not skip the other machine or the workspace", async () => {
  const { featureId, projectId } = await seedCard({ title: "Mixed machines", sandbox: false });
  await ctx.db.insert(sandboxes).values([
    {
      projectId,
      featureId,
      provider: "sprite",
      externalId: `sprite-${featureId}`,
      status: "ready",
      workdir: "/workspace",
    },
    {
      projectId,
      featureId,
      provider: "docker",
      externalId: `docker-${featureId}`,
      status: "ready",
      workdir: "/workspace",
    },
  ]);

  await reapSandbox(ctx, featureId);

  const rows = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  const sprite = rows.find((row) => row.provider === "sprite");
  const docker = rows.find((row) => row.provider === "docker");
  assert.equal(sprite?.status, "ready", "a machine this process cannot delete stays");
  assert.equal(docker?.status, "destroyed");
  assert.equal(destroyed.includes(`docker-${featureId}`), true, "the docker machine was destroyed");
  assert.equal(destroyed.includes(`sprite-${featureId}`), false, "the sprite was not asked");
  await assert.rejects(() => stat(ctx.worktrees.workspacePath(featureId)), { code: "ENOENT" });
});

/* ------------------------------------------------------------------ */
/* A swarm's reap reads the swarm again before anything goes.          */
/* ------------------------------------------------------------------ */

/** Sends nothing anywhere, and says what it was asked to send. */
async function withQuietBoss<T>(fn: (sent: unknown[]) => Promise<T>): Promise<T> {
  const sent: unknown[] = [];
  const previous = ctx.boss;
  ctx.boss = {
    send: async (_queue: string, data: unknown) => {
      sent.push(data);
      return "job";
    },
  } as AppContext["boss"];
  try {
    return await fn(sent);
  } finally {
    ctx.boss = previous;
  }
}

/**
 * Production, swarm 7a33f51d: a worker's failure briefly failed the
 * swarm and queued its reap, a person retried it, and the job ran a
 * second after the planner's run ended and destroyed the running
 * swarm's sprite with the two tasks that had landed on its branch.
 */
test("a reap queued for a swarm that is live again keeps its machine and ends quietly", async () => {
  for (const status of ["running", "planning", "paused"] as const) {
    const swarm = await seedSwarm({ title: `Swarm ${status} again`, status: "done" });
    // The reap was queued when the swarm ended. By the time it runs,
    // the swarm has been picked up again.
    await ctx.db.update(swarms).set({ status }).where(eq(swarms.id, swarm.swarmId));
    await withQuietBoss(async (sent) => {
      await runSandboxReapJob(ctx, { swarmId: swarm.swarmId });
      assert.deepEqual(sent, [], `a ${status} swarm is not asked about again`);
    });
    assert.equal(destroyed.includes(swarm.externalId), false, `a ${status} swarm keeps its machine`);
    const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
    assert.equal(row?.status, "ready");
  }
});

/**
 * Every ending a person can pick up again keeps the machine, because
 * it holds the branch they would pick it up on: a failed swarm is
 * retried, and one out of budget or time resumes when the ceiling is
 * raised. Archiving it is a person saying they are done with it.
 */
test("a swarm that failed or ran out of budget or time keeps its machine until it is archived", async () => {
  for (const status of ["failed", "budget_exhausted", "timed_out"] as const) {
    const swarm = await seedSwarm({ title: `Swarm ${status}`, status });
    await withQuietBoss(() => runSandboxReapJob(ctx, { swarmId: swarm.swarmId }));
    assert.equal(destroyed.includes(swarm.externalId), false, `a ${status} swarm keeps its machine`);

    await ctx.db.update(swarms).set({ archivedAt: new Date() }).where(eq(swarms.id, swarm.swarmId));
    await withQuietBoss(() => runSandboxReapJob(ctx, { swarmId: swarm.swarmId }));
    assert.ok(destroyed.includes(swarm.externalId), `an archived ${status} swarm gives its machine back`);
    const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
    assert.equal(row?.status, "destroyed");
  }
});

test("only a done or cancelled swarm releases its machine as it ends", () => {
  assert.equal(swarmReleasesMachine("done"), true);
  assert.equal(swarmReleasesMachine("cancelled"), true);
  for (const status of ["failed", "budget_exhausted", "timed_out", "running", "planning", "paused"] as const) {
    assert.equal(swarmReleasesMachine(status), false, `${status} keeps it`);
  }
  // A swarm that was deleted has nobody to keep a machine for.
  assert.equal(swarmMachineReleasable(undefined), true);
  // An archived swarm that is running is a person tidying their strip.
  assert.equal(
    swarmMachineReleasable({ status: "running", archivedAt: new Date(), updatedAt: new Date(0) }),
    false,
  );
});

test("the sweep gives a swarm out of budget or time the week a failed one gets", async () => {
  const recent = await seedSwarm({ title: "Swarm out of budget today", status: "budget_exhausted" });
  const abandonedBudget = await seedSwarm({ title: "Swarm out of budget long ago", status: "budget_exhausted" });
  const abandonedTime = await seedSwarm({ title: "Swarm out of time long ago", status: "timed_out" });
  await ctx.db
    .update(swarms)
    .set({ updatedAt: new Date(Date.now() - FAILED_SWARM_MACHINE_GRACE_MS - 60_000) })
    .where(sql`${swarms.id} in (${abandonedBudget.swarmId}, ${abandonedTime.swarmId})`);

  await reapFinishedSwarmSandboxes(ctx);

  assert.equal(destroyed.includes(recent.externalId), false, "raising the ceiling can still resume it");
  assert.ok(destroyed.includes(abandonedBudget.externalId));
  assert.ok(destroyed.includes(abandonedTime.externalId));
});

test("a reap waits for a landing in progress on the swarm's machine", async () => {
  const swarm = await seedSwarm({ title: "Swarm landing", status: "done" });
  const [task] = await ctx.db
    .insert(swarmTasks)
    .values({ swarmId: swarm.swarmId, title: "Leaf", status: "landed" })
    .returning();
  const [landing] = await ctx.db
    .insert(swarmLandings)
    .values({ swarmId: swarm.swarmId, taskId: task!.id, status: "landing", startedAt: new Date() })
    .returning();
  await withQuietBoss(async (sent) => {
    await runSandboxReapJob(ctx, { swarmId: swarm.swarmId });
    assert.deepEqual(sent, [{ swarmId: swarm.swarmId, deferrals: 1 }], "asked again once the landing may be done");
  });
  assert.equal(destroyed.includes(swarm.externalId), false, "its checks are not stopped under it");

  await ctx.db.update(swarmLandings).set({ status: "landed" }).where(eq(swarmLandings.id, landing!.id));
  await withQuietBoss(() => runSandboxReapJob(ctx, { swarmId: swarm.swarmId }));
  assert.ok(destroyed.includes(swarm.externalId));
});

/**
 * The reap holds the swarm's lock until its rows say destroyed, so a
 * retry that brings the swarm back either waits for the reap or is
 * seen by it. Here the retry holds the lock first: the reap waits, and
 * reads a swarm that is running.
 */
test("a reap that meets a retry holding the swarm waits and reads what the retry wrote", async () => {
  const swarm = await seedSwarm({ title: "Swarm retried under the reap", status: "done" });
  let locked: () => void = () => {};
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retry = ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from swarms where id = ${swarm.swarmId} for update`);
    await tx.update(swarms).set({ status: "running" }).where(eq(swarms.id, swarm.swarmId));
    locked();
    await released;
  });
  await isLocked;
  const reap = withQuietBoss(() => runSandboxReapJob(ctx, { swarmId: swarm.swarmId }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  await retry;
  await reap;
  assert.equal(destroyed.includes(swarm.externalId), false, "the running swarm keeps its machine");
});

/**
 * The branch release route holds the swarm locked in its own
 * transaction while it calls the reap. A reap that waited for that
 * lock without end would wait for itself.
 */
test("a reap called while its caller holds the swarm's lock reads the committed row", { timeout: 30_000 }, async () => {
  const swarm = await seedSwarm({ title: "Swarm branch released", status: "done" });
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select id from swarms where id = ${swarm.swarmId} for update`);
    await reapSwarmSandbox(ctx, swarm.swarmId);
  });
  assert.ok(destroyed.includes(swarm.externalId), "a done swarm's machine goes");
});

/**
 * A Modal machine is destroyed by name and by its hibernation image,
 * and only the handle names the image: without it the image billed
 * for up to thirty days, and exists() called a hibernated machine gone.
 */
test("a swarm's and a leaf's reap hand the driver the machine's image", async () => {
  const swarm = await seedSwarm({ title: "Swarm with an image", status: "done" });
  await ctx.db.update(sandboxes).set({ imageRef: "im-swarm" }).where(eq(sandboxes.id, swarm.sandboxId));
  const [task] = await ctx.db
    .insert(swarmTasks)
    .values({ swarmId: swarm.swarmId, title: "Leaf with an image", status: "landed" })
    .returning();
  const [project] = await ctx.db.select({ projectId: swarms.projectId }).from(swarms).where(eq(swarms.id, swarm.swarmId));
  await ctx.db.insert(sandboxes).values({
    projectId: project!.projectId,
    swarmId: swarm.swarmId,
    swarmTaskId: task!.id,
    provider: "docker",
    externalId: `leaf-box-${task!.id}`,
    status: "hibernated",
    imageRef: "im-leaf",
    workdir: "/workspace",
  });
  const handles: { externalId: string; imageRef?: string }[] = [];
  const previous = ctx.drivers;
  ctx.drivers = singleDriver({
    provider: "docker",
    workspace: "host",
    async destroy(handle: { externalId: string; imageRef?: string }) {
      handles.push(handle);
    },
    async exists() {
      return false;
    },
  } as unknown as SandboxDriver);
  try {
    await reapSwarmSandbox(ctx, swarm.swarmId);
    await reapSwarmTaskSandbox(ctx, task!.id);
  } finally {
    ctx.drivers = previous;
  }
  assert.deepEqual(
    handles.map((handle) => [handle.externalId, handle.imageRef]),
    [
      [swarm.externalId, "im-swarm"],
      [`leaf-box-${task!.id}`, "im-leaf"],
    ],
  );
});

test("a swarm machine this process cannot drive stays, and the rest still go", async () => {
  const swarm = await seedSwarm({ title: "Swarm on two providers", status: "cancelled" });
  const [project] = await ctx.db.select({ projectId: swarms.projectId }).from(swarms).where(eq(swarms.id, swarm.swarmId));
  const [sprite] = await ctx.db
    .insert(sandboxes)
    .values({
      projectId: project!.projectId,
      swarmId: swarm.swarmId,
      provider: "sprite",
      externalId: `sprite-${swarm.swarmId}`,
      status: "ready",
      workdir: "/workspace",
    })
    .returning();
  await reapSwarmSandbox(ctx, swarm.swarmId);
  const [kept] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, sprite!.id));
  assert.equal(kept?.status, "ready", "a machine this process cannot delete is not marked gone");
  const [gone] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
  assert.equal(gone?.status, "destroyed");
});
