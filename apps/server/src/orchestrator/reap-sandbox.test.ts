import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
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
  swarms,
} from "@bento/db";
import { WorktreeManager } from "@bento/sandbox";
import pg from "pg";
import { DiskArtifactStore } from "../artifact-store.js";
import { artifactStorageKey } from "./capture-artifacts.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { SecretBox } from "../secrets.js";
import { EventBus } from "../events.js";
import { reapFinishedSandboxes, reapSandbox, reapSwarmSandbox } from "./reap-sandbox.js";
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
    driver: {
      provider: "docker",
      async destroy(handle: { externalId: string }) {
        destroyed.push(handle.externalId);
      },
      async exists() {
        return false;
      },
    } as unknown as AppContext["driver"],
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

test("a swarm's machine is not taken out from under an agent still working in it", async () => {
  const swarm = await seedSwarm({ title: "Swarm with an agent", status: "cancelled", run: "running" });
  await assert.rejects(() => reapSwarmSandbox(ctx, swarm.swarmId), /still working/);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, swarm.sandboxId));
  assert.equal(row?.status, "ready", "the row still points at a machine that is there");
});
