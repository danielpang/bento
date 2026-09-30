import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  createDb,
  createPool,
  agentProfiles,
  agentRuns,
  features,
  pipelines,
  projects,
  runMigrations,
  sandboxes,
  stages,
} from "@bento/db";
import { ModalDriver, MODAL_REPO_PREPARE_TIMEOUT_MS, WorktreeManager, type ModalApi, type SandboxDriver } from "@bento/sandbox";
import { singleDriver } from "./sandbox-driver.js";
import pg from "pg";
import { DiskArtifactStore } from "../artifact-store.js";
import { ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { SecretBox } from "../secrets.js";
import { EventBus } from "../events.js";
import {
  HIBERNATE_SANDBOX_QUEUE,
  MODAL_SWEEP_GRACE_MS,
  hibernateSandbox,
  scheduleModalHibernation,
  sweepOrphanModalSandboxes,
} from "./hibernate-sandbox.js";
import { sandboxProvisionConflict } from "./run-executor.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "hibernate_sandbox_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
const jobs: { name: string; data: { sandboxId?: string } }[] = [];

async function scratchDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await scratchDir("bento-hibernate-data-");
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
      send: async (name: string, data: { sandboxId?: string }) => {
        jobs.push({ name, data });
        return "job";
      },
    } as AppContext["boss"],
    bus: new EventBus(),
    drivers: singleDriver({ provider: "local-process", workspace: "host" } as unknown as SandboxDriver),
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

function jobsFor(sandboxId: string) {
  return jobs.filter((job) => job.name === HIBERNATE_SANDBOX_QUEUE && job.data.sandboxId === sandboxId);
}

function useModal(api: ModalApi): ModalDriver {
  const modal = new ModalDriver({ tokenId: "id", tokenSecret: "secret", api });
  ctx.drivers = singleDriver(modal);
  return modal;
}

async function seed(opts: {
  title: string;
  sandboxStatus?: "ready" | "busy" | "hibernated" | "destroyed";
  provider?: "docker" | "sprite" | "modal";
  imageRef?: string | null;
  externalId?: string;
}): Promise<{
  featureId: string;
  projectId: string;
  stageId: string;
  profileId: string;
  sandboxId: string;
}> {
  const featureId = randomUUID();
  const [project] = await ctx.db
    .insert(projects)
    .values({ ownerId: ctx.userId, name: opts.title, localPath: "/tmp/unused" })
    .returning();
  const [pipeline] = await ctx.db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "Default", isDefault: true })
    .returning();
  const [stage] = await ctx.db
    .insert(stages)
    .values({ pipelineId: pipeline!.id, position: 0, name: "Implementation", slug: "implementation" })
    .returning();
  await ctx.db.insert(features).values({
    id: featureId,
    projectId: project!.id,
    pipelineId: pipeline!.id,
    title: opts.title,
  });
  const [profile] = await ctx.db
    .insert(agentProfiles)
    .values({ ownerId: ctx.userId, name: `agent-${featureId}`, cli: "fake", model: "fake-1" })
    .returning();
  const [sandbox] = await ctx.db
    .insert(sandboxes)
    .values({
      projectId: project!.id,
      featureId,
      provider: opts.provider ?? "modal",
      externalId: opts.externalId ?? `bento-${featureId}`,
      status: opts.sandboxStatus ?? "ready",
      workdir: "/workspace",
      ...(opts.imageRef !== undefined ? { imageRef: opts.imageRef } : {}),
    })
    .returning();
  return {
    featureId,
    projectId: project!.id,
    stageId: stage!.id,
    profileId: profile!.id,
    sandboxId: sandbox!.id,
  };
}

function idleApi(options?: {
  running?: boolean;
  dead?: boolean;
  exitSnapshot?: () => Promise<{ imageId: string }>;
  onTerminate?: () => void;
  onSnapshot?: () => Promise<{ imageId: string }>;
}): ModalApi {
  const box = {
    sandboxId: "sb-1",
    poll: async () => (options?.dead ? 1 : null),
    terminate: async () => {
      options?.onTerminate?.();
    },
    exec: async () => ({
      async *stdout() {},
      stdoutText: async () => "",
      stderrText: async () => "",
      wait: async () => 0,
      writeStdin: async () => {},
      endStdin: async () => {},
    }),
    readText: async () => null,
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    listDir: async () => [],
    remove: async () => {},
    snapshotDirectory: async () => ({ imageId: "im-dir" }),
    snapshotFilesystem: async () => options?.onSnapshot?.() ?? { imageId: "im-fs" },
    mountImage: async () => {},
    experimentalGetExitSnapshot: async () => {
      if (options?.exitSnapshot) return options.exitSnapshot();
      throw new Error("no snapshot");
    },
    getTags: async () => ({ bento_created: String(Date.now()) }),
  };
  return {
    fromName: async () => (options?.dead || options?.running ? box : null),
    create: async () => box,
    imageFromId: async (id: string) => ({ imageId: id }),
    deleteImage: async () => {},
    toolchainImage: async () => ({ imageId: "im-toolchain" }),
    listRunning: async () => [],
  } as ModalApi;
}

async function provisionLines(modal: ModalDriver, featureId: string, projectId: string): Promise<string[]> {
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId)).limit(1);
  const lines: string[] = [];
  await modal.provision({
    projectId,
    workspaceKey: featureId,
    hostWorkspacePath: "/tmp/unused",
    ...(row?.imageRef ? { imageRef: row.imageRef } : {}),
    ...(row?.status === "hibernated" && !row.imageRef ? { missingSnapshot: true } : {}),
    onProgress: (line) => {
      lines.push(line);
    },
  });
  return lines;
}

test("a hibernation with no reachable exit snapshot does not keep the previous image", async () => {
  const card = await seed({ title: "stale image", sandboxStatus: "ready", imageRef: "im-old" });
  const modal = useModal(idleApi());
  await hibernateSandbox(ctx, card.sandboxId);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, card.sandboxId));
  assert.equal(row?.status, "hibernated");
  assert.equal(row?.imageRef, null);
  const restarted = new ModalDriver({ tokenId: "id", tokenSecret: "secret", api: idleApi() });
  const lines = await provisionLines(restarted, card.featureId, card.projectId);
  assert.ok(lines.includes("The previous sandbox left no usable snapshot, so this one starts from a fresh clone."));
  assert.equal(lines.includes("Restoring the workspace from its last snapshot"), false);
  assert.equal(modal.provider, "modal");
});

test("a thrown exit snapshot is a fresh clone, not the older image", async () => {
  const card = await seed({ title: "thrown snapshot", sandboxStatus: "ready", imageRef: "im-old" });
  useModal(idleApi({ dead: true }));
  await hibernateSandbox(ctx, card.sandboxId);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, card.sandboxId));
  assert.equal(row?.status, "hibernated");
  assert.equal(row?.imageRef, null);
  const restarted = new ModalDriver({ tokenId: "id", tokenSecret: "secret", api: idleApi() });
  const lines = await provisionLines(restarted, card.featureId, card.projectId);
  assert.ok(lines.includes("The previous sandbox left no usable snapshot, so this one starts from a fresh clone."));
  assert.equal(lines.includes("Restoring the workspace from its last snapshot"), false);
});

test("hibernation loses the race with a run that already started", async () => {
  const card = await seed({ title: "race", sandboxStatus: "ready", imageRef: "im-old" });
  let terminated = false;
  let release: () => void = () => {};
  let started: () => void = () => {};
  const snapshotStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  useModal(
    idleApi({
      running: true,
      onTerminate: () => {
        terminated = true;
      },
      onSnapshot: async () => {
        started();
        await gate;
        return { imageId: "im-during-race" };
      },
    }),
  );
  const pending = hibernateSandbox(ctx, card.sandboxId);
  await Promise.race([
    snapshotStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("snapshot did not start")), 5_000)),
  ]);
  await ctx.db.update(sandboxes).set({ status: "busy" }).where(eq(sandboxes.id, card.sandboxId));
  await ctx.db.insert(agentRuns).values({
    featureId: card.featureId,
    stageId: card.stageId,
    agentProfileId: card.profileId,
    prompt: "next stage",
    status: "running",
    sandboxId: card.sandboxId,
  });
  release();
  await pending;
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, card.sandboxId));
  assert.equal(terminated, false);
  assert.equal(row?.status, "busy");
  assert.equal(row?.imageRef, "im-old");
  assert.equal(jobsFor(card.sandboxId).length, 1);
});

test("a skip and a finish on an already ready row each arm a later hibernation", async () => {
  const skipped = await seed({ title: "skip", sandboxStatus: "ready" });
  await ctx.db.insert(agentRuns).values({
    featureId: skipped.featureId,
    stageId: skipped.stageId,
    agentProfileId: skipped.profileId,
    prompt: "still going",
    status: "running",
    sandboxId: skipped.sandboxId,
  });
  useModal(idleApi());
  await hibernateSandbox(ctx, skipped.sandboxId);
  const [skipRow] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, skipped.sandboxId));
  assert.equal(skipRow?.status, "ready");
  assert.equal(jobsFor(skipped.sandboxId).length, 1);

  const finished = await seed({ title: "already ready", sandboxStatus: "busy" });
  const [run] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: finished.featureId,
      stageId: finished.stageId,
      agentProfileId: finished.profileId,
      prompt: "done",
      status: "succeeded",
      sandboxId: finished.sandboxId,
    })
    .returning();
  await scheduleModalHibernation(ctx, run!.id);
  await scheduleModalHibernation(ctx, run!.id);
  const [ready] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, finished.sandboxId));
  assert.equal(ready?.status, "ready");
  assert.equal(jobsFor(finished.sandboxId).length, 2);
});

test("a ready or busy conflict keeps the provider and a destroyed conflict takes the new one", async () => {
  const ready = await seed({
    title: "keep provider",
    sandboxStatus: "ready",
    provider: "sprite",
    imageRef: "im-sprite",
    externalId: `sprite-${randomUUID()}`,
  });
  await ctx.db
    .insert(sandboxes)
    .values({
      projectId: ready.projectId,
      featureId: ready.featureId,
      provider: "modal",
      externalId: (await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, ready.sandboxId)))[0]!.externalId,
      status: "busy",
      workdir: "/workspace",
    })
    .onConflictDoUpdate({
      target: sandboxes.externalId,
      set: sandboxProvisionConflict({
        featureId: ready.featureId,
        provider: "modal",
        workdir: "/workspace",
      }),
    });
  const [kept] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, ready.sandboxId));
  assert.equal(kept?.provider, "sprite");
  assert.equal(kept?.status, "busy");
  assert.equal(kept?.imageRef, "im-sprite");

  const busy = await seed({
    title: "busy provider",
    sandboxStatus: "busy",
    provider: "sprite",
    imageRef: "im-busy",
    externalId: `busy-${randomUUID()}`,
  });
  const [busyRow] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, busy.sandboxId));
  await ctx.db
    .insert(sandboxes)
    .values({
      projectId: busy.projectId,
      featureId: busy.featureId,
      provider: "modal",
      externalId: busyRow!.externalId,
      status: "busy",
      workdir: "/workspace",
    })
    .onConflictDoUpdate({
      target: sandboxes.externalId,
      set: sandboxProvisionConflict({
        featureId: busy.featureId,
        provider: "modal",
        workdir: "/workspace",
      }),
    });
  const [stillSprite] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, busy.sandboxId));
  assert.equal(stillSprite?.provider, "sprite");
  assert.equal(stillSprite?.imageRef, "im-busy");

  const destroyed = await seed({
    title: "destroyed provider",
    sandboxStatus: "destroyed",
    provider: "sprite",
    imageRef: "im-dead",
    externalId: `dead-${randomUUID()}`,
  });
  const [deadRow] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, destroyed.sandboxId));
  await ctx.db
    .insert(sandboxes)
    .values({
      projectId: destroyed.projectId,
      featureId: destroyed.featureId,
      provider: "modal",
      externalId: deadRow!.externalId,
      status: "busy",
      workdir: "/workspace",
    })
    .onConflictDoUpdate({
      target: sandboxes.externalId,
      set: sandboxProvisionConflict({
        featureId: destroyed.featureId,
        provider: "modal",
        workdir: "/workspace",
      }),
    });
  const [replaced] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, destroyed.sandboxId));
  assert.equal(replaced?.provider, "modal");
  assert.equal(replaced?.imageRef, null);

  const hibernated = await seed({
    title: "clear dead image",
    sandboxStatus: "hibernated",
    provider: "modal",
    imageRef: "im-expired",
    externalId: `expired-${randomUUID()}`,
  });
  const [expired] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, hibernated.sandboxId));
  await ctx.db
    .insert(sandboxes)
    .values({
      projectId: hibernated.projectId,
      featureId: hibernated.featureId,
      provider: "modal",
      externalId: expired!.externalId,
      status: "busy",
      workdir: "/workspace",
    })
    .onConflictDoUpdate({
      target: sandboxes.externalId,
      set: sandboxProvisionConflict({
        featureId: hibernated.featureId,
        provider: "modal",
        workdir: "/workspace",
        recordedImageRef: null,
      }),
    });
  const [cleared] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.id, hibernated.sandboxId));
  assert.equal(cleared?.provider, "modal");
  assert.equal(cleared?.status, "busy");
  assert.equal(cleared?.imageRef, null);
});

test("the orphan sweep spares a sandbox that is still being provisioned", async () => {
  const youngFeature = randomUUID();
  const oldFeature = randomUUID();
  const active = await seed({ title: "active clone", sandboxStatus: "destroyed" });
  await ctx.db.insert(agentRuns).values({
    featureId: active.featureId,
    stageId: active.stageId,
    agentProfileId: active.profileId,
    prompt: "cloning",
    status: "starting",
  });
  const terminated: string[] = [];
  const youngName = `bento-${youngFeature}`;
  const oldName = `bento-${oldFeature}`;
  const activeName = `bento-${active.featureId}`;
  const age = {
    [youngName]: Date.now() - 16 * 60 * 1000,
    [oldName]: Date.now() - MODAL_SWEEP_GRACE_MS - 60_000,
    [activeName]: Date.now() - MODAL_SWEEP_GRACE_MS - 60_000,
  } as Record<string, number>;
  useModal({
    fromName: async (name: string) => ({
      sandboxId: name,
      poll: async () => null,
      terminate: async () => {
        terminated.push(name);
      },
      experimentalGetExitSnapshot: async () => {
        throw new Error("no snapshot");
      },
      exec: async () => {
        throw new Error("unused");
      },
      readText: async () => null,
      readBytes: async () => new Uint8Array(),
      writeBytes: async () => {},
      listDir: async () => [],
      remove: async () => {},
      snapshotDirectory: async () => ({ imageId: "im-dir" }),
      snapshotFilesystem: async () => ({ imageId: "im-fs" }),
      mountImage: async () => {},
      getTags: async () => ({}),
    }),
    create: async () => {
      throw new Error("unused");
    },
    imageFromId: async () => null,
    deleteImage: async () => {},
    toolchainImage: async () => ({ imageId: "im-toolchain" }),
    listRunning: async () => [
      { externalId: youngName, tags: { bento_feature: youngFeature, bento_created: String(age[youngName]) } },
      { externalId: oldName, tags: { bento_feature: oldFeature, bento_created: String(age[oldName]) } },
      { externalId: activeName, tags: { bento_feature: active.featureId, bento_created: String(age[activeName]) } },
    ],
  } as ModalApi);
  assert.ok(16 * 60 * 1000 > MODAL_REPO_PREPARE_TIMEOUT_MS);
  assert.ok(16 * 60 * 1000 < MODAL_SWEEP_GRACE_MS);
  await sweepOrphanModalSandboxes(ctx);
  assert.deepEqual(terminated, [oldName]);
});
