import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, createPool, features, pipelines, projects, runMigrations, sandboxes } from "@bento/db";
import { SpriteProvisionLeak, WorktreeManager, type ProvisionSpec, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import pg from "pg";
import { ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { SecretBox } from "../secrets.js";
import { recordingAnalytics } from "../test-analytics.js";
import { singleDriver } from "./sandbox-driver.js";
import { SANDBOX_PROVISIONED_EVENT } from "./sandbox-metrics.js";
import { provisionWorkspace } from "./sandbox-provision.js";

/**
 * The "auto" order at the point it matters: provisionWorkspace asking
 * one driver, then the next. Stub drivers stand in for Fly and Modal,
 * because the question is which one gets asked and what is recorded,
 * not whether either can make a machine.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "sandbox_provision_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let analytics: ReturnType<typeof recordingAnalytics>;
let projectId: string;
let pipelineId: string;

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "bento-provision-")));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);
  const pool = createPool(testUrl);
  const db = createDb(pool);
  const userId = await ensureLocalUser(db);
  analytics = recordingAnalytics();
  ctx = {
    env,
    db,
    pool,
    drivers: singleDriver({ provider: "local-process", workspace: "host" } as unknown as SandboxDriver),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    analytics: analytics.analytics,
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  } as unknown as AppContext;

  const [project] = await db.insert(projects).values({ ownerId: userId, name: "Auto" }).returning();
  projectId = project!.id;
  const [pipeline] = await db
    .insert(pipelines)
    .values({ projectId, name: "Default", isDefault: true })
    .returning();
  pipelineId = pipeline!.id;
});

after(async () => {
  await ctx.pool.end();
});

async function seedFeature(title: string): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(features).values({ id, projectId, pipelineId, title });
  return id;
}

/** A clone driver that answers, or throws, and remembers being asked. */
function stubDriver(
  provider: "sprite" | "modal",
  asked: string[],
  opts: { fail?: Error; restricted?: boolean; destroyed?: string[] } = {},
): SandboxDriver {
  return {
    provider,
    workspace: "clone",
    sandboxSize: provider === "sprite" ? "sprite-standard" : "modal-small",
    ...(opts.restricted ? { supportsRestrictedNetwork: true } : {}),
    async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
      asked.push(provider);
      if (opts.fail) throw opts.fail;
      return { externalId: `${provider}-${spec.workspaceKey}`, provider, workdir: "/workspace", createdSandbox: true };
    },
    exec: async function* () {
      yield { kind: "exit" as const, exitCode: 0 };
    },
    async destroy(handle: SandboxHandle) {
      opts.destroyed?.push(handle.externalId);
    },
  } as unknown as SandboxDriver;
}

function provisionEvents() {
  return analytics.events.filter((e) => e.event === SANDBOX_PROVISIONED_EVENT);
}

async function provisionOn(
  featureId: string,
  driver: SandboxDriver,
  fallbackDrivers: SandboxDriver[],
  said: string[],
  restrictNetwork = false,
) {
  return provisionWorkspace(ctx, {
    driver,
    fallbackDrivers,
    selection: fallbackDrivers.length > 0 || driver.provider !== "sprite" ? "auto" : "project",
    startedBy: ctx.userId,
    projectId,
    organizationId: null,
    workspaceKey: featureId,
    branch: `bento/${featureId}`,
    repoRows: [],
    authMounts: [],
    restrictNetwork,
    owner: { featureId },
    say: async (text) => {
      said.push(text);
    },
  });
}

test("auto lands on the sprite when Fly answers, and says so in the metric", async () => {
  const featureId = await seedFeature("Sprite answers");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked);
  const modal = stubDriver("modal", asked, { restricted: true });
  const before = provisionEvents().length;

  const result = await provisionOn(featureId, sprite, [modal], said);

  assert.deepEqual(asked, ["sprite"]);
  assert.equal(result.driver, sprite);
  assert.equal(result.handle.provider, "sprite");
  assert.equal(result.sandboxRow?.provider, "sprite");
  assert.equal(result.sandboxRow?.size, "sprite-standard");
  assert.deepEqual(said, []);
  const events = provisionEvents().slice(before);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.userId, ctx.userId);
  assert.deepEqual(events[0]?.properties, {
    provider: "sprite",
    selection: "auto",
    fell_back_from: null,
    fell_back: false,
    attempts: 1,
    project_id: projectId,
    feature_id: featureId,
  });
});

test("auto falls back to Modal when the sprite cannot be provisioned", async () => {
  const featureId = await seedFeature("Fly is down");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("sprites API returned 503\nmore detail") });
  const modal = stubDriver("modal", asked, { restricted: true });
  const before = provisionEvents().length;
  const exceptionsBefore = analytics.exceptions.length;

  const result = await provisionOn(featureId, sprite, [modal], said);

  assert.deepEqual(asked, ["sprite", "modal"]);
  assert.equal(result.driver, modal);
  assert.notEqual(result.driver, sprite);
  assert.equal(result.handle.provider, "modal");
  assert.equal(result.handle.externalId, `modal-${featureId}`);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  assert.equal(row?.provider, "modal");
  assert.equal(row?.size, "modal-small");
  assert.equal(row?.status, "busy");
  assert.deepEqual(said, ["Fly Sprites could not provide a sandbox (sprites API returned 503). Trying Modal."]);

  const events = provisionEvents().slice(before);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.properties, {
    provider: "modal",
    selection: "auto",
    fell_back_from: "sprite",
    fell_back: true,
    attempts: 2,
    project_id: projectId,
    feature_id: featureId,
  });
  const fallbackErrors = analytics.exceptions.slice(exceptionsBefore);
  assert.equal(fallbackErrors.length, 1);
  assert.equal(fallbackErrors[0]?.error.message, "sprites API returned 503\nmore detail");
  assert.equal(fallbackErrors[0]?.properties?.source, "sandbox_provision_fallback");
  assert.equal(fallbackErrors[0]?.properties?.provider, "sprite");
  assert.equal(fallbackErrors[0]?.properties?.next_provider, "modal");
});

test("a project that named its provider fails plainly instead of moving", async () => {
  const featureId = await seedFeature("Pinned to Fly");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("sprites API returned 503") });
  const before = provisionEvents().length;

  await assert.rejects(provisionOn(featureId, sprite, [], said), /sprites API returned 503/);

  assert.deepEqual(asked, ["sprite"]);
  assert.deepEqual(said, []);
  assert.equal(provisionEvents().length, before);
  const rows = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  assert.equal(rows.length, 0);
});

test("when every driver fails, the last error is the run's and the first is still counted", async () => {
  const featureId = await seedFeature("Everything is down");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("sprite failed") });
  const modal = stubDriver("modal", asked, { fail: new Error("modal failed"), restricted: true });
  const before = provisionEvents().length;
  const exceptionsBefore = analytics.exceptions.length;

  await assert.rejects(provisionOn(featureId, sprite, [modal], said), /modal failed/);

  assert.deepEqual(asked, ["sprite", "modal"]);
  assert.deepEqual(said, ["Fly Sprites could not provide a sandbox (sprite failed). Trying Modal."]);
  assert.equal(provisionEvents().length, before);
  const fallbackErrors = analytics.exceptions.slice(exceptionsBefore);
  assert.equal(fallbackErrors.length, 1);
  assert.equal(fallbackErrors[0]?.error.message, "sprite failed");
});

test("a locked network never asks the sprite and goes straight to Modal", async () => {
  const featureId = await seedFeature("Locked down");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked);
  const modal = stubDriver("modal", asked, { restricted: true });
  const before = provisionEvents().length;

  const result = await provisionOn(featureId, sprite, [modal], said, true);

  assert.deepEqual(asked, ["modal"]);
  assert.equal(result.driver, modal);
  assert.deepEqual(said, []);
  const events = provisionEvents().slice(before);
  assert.equal(events[0]?.properties?.provider, "modal");
  assert.equal(events[0]?.properties?.fell_back_from, null);
  assert.equal(events[0]?.properties?.attempts, 1);
});

test("a locked network with no driver that honors it refuses before asking any", async () => {
  const featureId = await seedFeature("Locked with nowhere to go");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked);
  const other = stubDriver("modal", asked);

  await assert.rejects(provisionOn(featureId, sprite, [other], said, true), /without network access/);
  assert.deepEqual(asked, []);
});

test("a sprite created and then failed is destroyed when the loop moves on to Modal", async () => {
  const featureId = await seedFeature("Leaked sprite, Modal next");
  const asked: string[] = [];
  const said: string[] = [];
  const destroyed: string[] = [];
  const leak = new SpriteProvisionLeak("tool install failed", `bento-${featureId}`, new Error("tool install failed"));
  const sprite = stubDriver("sprite", asked, { fail: leak, destroyed });
  const modal = stubDriver("modal", asked, { restricted: true });

  const result = await provisionOn(featureId, sprite, [modal], said);

  assert.equal(result.driver, modal);
  assert.deepEqual(asked, ["sprite", "modal"]);
  assert.deepEqual(destroyed, [`bento-${featureId}`]);
  // The transcript and the metric carry the failure, not the wrapper.
  assert.deepEqual(said, ["Fly Sprites could not provide a sandbox (tool install failed). Trying Modal."]);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  assert.equal(row?.provider, "modal");
});

test("a sprite created and then failed is kept when it was the last driver, for the retry to reuse", async () => {
  const featureId = await seedFeature("Leaked sprite, nothing next");
  const asked: string[] = [];
  const said: string[] = [];
  const destroyed: string[] = [];
  const leak = new SpriteProvisionLeak("clone failed", `bento-${featureId}`, new Error("clone failed"));
  const sprite = stubDriver("sprite", asked, { fail: leak, destroyed });

  await assert.rejects(provisionOn(featureId, sprite, [], said), (err: unknown) => err === leak);
  assert.deepEqual(asked, ["sprite"]);
  assert.deepEqual(destroyed, []);
});

test("a transcript that cannot be written does not stop the fallback", async () => {
  const featureId = await seedFeature("Transcript down");
  const asked: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("sprite failed") });
  const modal = stubDriver("modal", asked, { restricted: true });

  const result = await provisionWorkspace(ctx, {
    driver: sprite,
    fallbackDrivers: [modal],
    selection: "auto",
    projectId,
    organizationId: null,
    workspaceKey: featureId,
    branch: `bento/${featureId}`,
    repoRows: [],
    authMounts: [],
    restrictNetwork: false,
    owner: { featureId },
    say: async () => {
      throw new Error("messages insert failed");
    },
  });

  assert.equal(result.driver, modal);
  assert.deepEqual(asked, ["sprite", "modal"]);
});

test("a fallback of another workspace shape is not tried", async () => {
  const featureId = await seedFeature("Shape mismatch");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("sprite failed") });
  const host = { ...stubDriver("modal", asked), workspace: "host" } as SandboxDriver;

  await assert.rejects(provisionOn(featureId, sprite, [host], said), /sprite failed/);
  assert.deepEqual(asked, ["sprite"]);
});
