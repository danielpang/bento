import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import {
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  projects,
  repositories,
  runEvents,
  runMigrations,
  sandboxes,
  swarmLandings,
  swarmTasks,
  swarms,
} from "@bento/db";
import { SandboxImageLost, WorktreeManager, type SandboxDriver } from "@bento/sandbox";
import { DiskArtifactStore } from "../artifact-store.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { EventBus } from "../events.js";
import { SecretBox } from "../secrets.js";
import { SWARM_BRANCH_LOST_MESSAGE, unbilledReason } from "../unbilled-reasons.js";
import { executeRun } from "./run-executor.js";
import { singleDriver } from "./sandbox-driver.js";

/**
 * A swarm's own machine is never made again without the work that had
 * landed on it.
 *
 * Production, swarm 7a33f51d: a reap destroyed the live swarm's sprite
 * and the two tasks landed on its branch with it. The next planner run
 * found the row destroyed, nothing on GitHub to restore from, and made
 * a fresh clone on the fallback provider without a word, and the swarm
 * went on landing onto a branch that was missing its earlier work.
 */

const run = promisify(execFile);

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_branch_lost_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let projectId: string;
let profileId: string;
let provisioned: number;
let captured: { message: string; properties: Record<string, unknown> }[];

/** A clone driver that refuses to make a machine, and counts being asked. */
function cloneDriver(provider: "sprite" | "modal", extra: Partial<SandboxDriver> = {}): SandboxDriver {
  return {
    provider,
    workspace: "clone",
    async provision() {
      provisioned += 1;
      throw new Error("the test provider makes no machines");
    },
    async destroy() {},
    ...extra,
  } as unknown as SandboxDriver;
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "bento-branch-lost-")));
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
    drivers: singleDriver(cloneDriver("sprite")),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
    analytics: {
      capture: () => {},
      captureException: (err: unknown, _user: unknown, _org: unknown, properties?: Record<string, unknown>) =>
        void captured.push({ message: (err as Error).message, properties: properties ?? {} }),
    } as unknown as AppContext["analytics"],
  };
  // A remote the server can ask for its HEAD, so a provision that is
  // allowed goes as far as asking the driver for a machine.
  const remote = path.join(dataDir, "remote");
  await mkdir(remote);
  await run("git", ["-C", remote, "init", "-qb", "main"]);
  await writeFile(path.join(remote, "README.md"), "remote\n");
  await run("git", ["-C", remote, "add", "-A"]);
  await run("git", ["-C", remote, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "init"]);
  const [project] = await db
    .insert(projects)
    .values({ ownerId: userId, name: "Branch lost", defaultBranch: "main" })
    .returning();
  projectId = project!.id;
  await db.insert(repositories).values({
    projectId,
    name: "app",
    localPath: remote,
    repoUrl: remote,
    defaultBranch: "main",
    position: 0,
  });
  const [profile] = await db
    .insert(agentProfiles)
    .values({ ownerId: userId, name: "Planner", cli: "fake", model: "fake-1" })
    .returning();
  profileId = profile!.id;
});

after(async () => {
  await ctx.pool.end();
});

beforeEach(() => {
  provisioned = 0;
  captured = [];
  ctx.drivers = singleDriver(cloneDriver("sprite"));
});

/**
 * A swarm whose own machine is the row given, with nothing pushed to
 * GitHub, and a landed task when `landed` says so.
 */
async function swarmWith(opts: {
  sandbox: "destroyed" | "ready" | null;
  provider?: "sprite" | "modal";
  landed: boolean;
}) {
  const slug = `s-${randomUUID().slice(0, 8)}`;
  const [swarm] = await ctx.db
    .insert(swarms)
    .values({
      projectId,
      slug,
      title: "Swarm",
      goal: "goal",
      status: "running",
      workerIsolation: "sandbox",
      plannerProfileId: profileId,
      workerProfileId: profileId,
      branchName: `bento/swarm-${slug}`,
    })
    .returning();
  if (opts.sandbox) {
    const [row] = await ctx.db
      .insert(sandboxes)
      .values({
        projectId,
        swarmId: swarm!.id,
        provider: opts.provider ?? "sprite",
        externalId: `bento-swarm-${swarm!.id}`,
        status: opts.sandbox,
        workdir: "/workspace",
        imageRef: opts.provider === "modal" ? "im-expired" : null,
      })
      .returning();
    await ctx.db.update(swarms).set({ sandboxId: row!.id }).where(eq(swarms.id, swarm!.id));
  }
  const [task] = await ctx.db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, title: "Landed leaf", status: opts.landed ? "landed" : "working" })
    .returning();
  if (opts.landed) {
    await ctx.db.insert(swarmLandings).values({ swarmId: swarm!.id, taskId: task!.id, status: "landed" });
  }
  return { swarmId: swarm!.id, taskId: task!.id };
}

async function queueRun(swarmId: string, role: "planner" | "worker", taskId?: string) {
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId,
      role,
      agentProfileId: profileId,
      prompt: "",
      status: "queued",
      ...(taskId ? { swarmTaskId: taskId } : {}),
    })
    .returning();
  if (taskId) await ctx.db.update(swarmTasks).set({ assignedRunId: run!.id }).where(eq(swarmTasks.id, taskId));
  return run!.id;
}

async function runRow(runId: string) {
  const [row] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  return row!;
}

async function systemLines(runId: string): Promise<string[]> {
  const rows = await ctx.db.select().from(runEvents).where(eq(runEvents.runId, runId));
  return rows
    .map((row) => row.payload as { role?: string; text?: string })
    .filter((payload) => payload.role === "system")
    .map((payload) => payload.text ?? "");
}

function assertRefused(row: Awaited<ReturnType<typeof runRow>>) {
  assert.equal(row.status, "failed");
  assert.equal(row.error, SWARM_BRANCH_LOST_MESSAGE);
  assert.equal(unbilledReason(row.error)?.id, "swarm-branch-lost", "no agent ran, so it is not billed");
  assert.equal(provisioned, 0, "no machine was made on a branch without the landed work");
  assert.ok(
    captured.some((entry) => entry.properties.source === "swarm_branch_lost"),
    "and error tracking hears of it as lost work",
  );
}

test("a planner whose swarm machine is gone with landed work on it is refused, not given a fresh clone", async () => {
  const { swarmId } = await swarmWith({ sandbox: "destroyed", landed: true });
  const runId = await queueRun(swarmId, "planner");
  await executeRun(ctx, runId);
  assertRefused(await runRow(runId));
  assert.ok((await systemLines(runId)).includes(SWARM_BRANCH_LOST_MESSAGE), "the transcript says why");
});

test("a swarm with nothing landed yet still starts its machine fresh", async () => {
  const { swarmId } = await swarmWith({ sandbox: "destroyed", landed: false });
  const runId = await queueRun(swarmId, "planner");
  await executeRun(ctx, runId);
  const row = await runRow(runId);
  assert.equal(provisioned, 1, "a branch with nothing on it is the base, so a fresh clone is right");
  assert.notEqual(row.error, SWARM_BRANCH_LOST_MESSAGE);
});

test("a worker whose swarm machine is gone with landed work is refused rather than cut from the base", async () => {
  const { swarmId, taskId } = await swarmWith({ sandbox: "destroyed", landed: true });
  const runId = await queueRun(swarmId, "worker", taskId);
  await executeRun(ctx, runId);
  assertRefused(await runRow(runId));
});

/**
 * The row said the machine was there and it was not. Waking it finds
 * that out and marks the row, and the worker takes the path a machine
 * that is gone already has: GitHub, and here, the refusal.
 */
test("a worker whose swarm sprite vanished under a live row marks the row and is refused", async () => {
  const exported: string[] = [];
  ctx.drivers = singleDriver(
    cloneDriver("sprite", {
      exists: async () => false,
      exportRepository: async (handle: { externalId: string }) => {
        exported.push(handle.externalId);
        throw new Error("sandbox is not running");
      },
    } as Partial<SandboxDriver>),
  );
  const { swarmId, taskId } = await swarmWith({ sandbox: "ready", landed: true });
  const runId = await queueRun(swarmId, "worker", taskId);
  await executeRun(ctx, runId);
  assertRefused(await runRow(runId));
  assert.deepEqual(exported, [], "nothing is exec'd into a machine that is not there");
  const [row] = await ctx.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.swarmId, swarmId), eq(sandboxes.provider, "sprite")));
  assert.equal(row?.status, "destroyed");
});

test("a worker whose swarm Modal box stopped with no snapshot left marks the row and is refused", async () => {
  ctx.drivers = singleDriver(
    cloneDriver("modal", {
      wake: async (handle: { externalId: string }) => {
        throw new SandboxImageLost(handle.externalId);
      },
    } as Partial<SandboxDriver>),
  );
  const { swarmId, taskId } = await swarmWith({ sandbox: "ready", provider: "modal", landed: true });
  const runId = await queueRun(swarmId, "worker", taskId);
  await executeRun(ctx, runId);
  assertRefused(await runRow(runId));
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.swarmId, swarmId));
  assert.equal(row?.status, "destroyed");
});

test("a planner whose swarm sprite vanished under a live row is refused, not given a fresh clone", async () => {
  ctx.drivers = singleDriver(cloneDriver("sprite", { exists: async () => false } as Partial<SandboxDriver>));
  const { swarmId } = await swarmWith({ sandbox: "ready", landed: true });
  const runId = await queueRun(swarmId, "planner");
  await executeRun(ctx, runId);
  assertRefused(await runRow(runId));
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.swarmId, swarmId));
  assert.equal(row?.status, "destroyed");
});

test("a planner whose swarm Modal box stopped is woken from its snapshot and provisioned as usual", async () => {
  let woke = 0;
  ctx.drivers = singleDriver(
    cloneDriver("modal", { wake: async () => (woke++, { booted: true }) } as Partial<SandboxDriver>),
  );
  const { swarmId } = await swarmWith({ sandbox: "ready", provider: "modal", landed: true });
  const runId = await queueRun(swarmId, "planner");
  await executeRun(ctx, runId);
  assert.equal(woke, 1, "the box is asked about before the run trusts the row");
  assert.notEqual((await runRow(runId)).error, SWARM_BRANCH_LOST_MESSAGE);
  assert.equal(provisioned, 1);
});
