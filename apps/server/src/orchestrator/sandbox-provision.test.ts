import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDb, createPool, features, pipelines, projects, repositories, runMigrations, sandboxes } from "@bento/db";
import { ProvisionFailure, WorktreeManager, spriteName, type ProvisionSpec, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";
import pg from "pg";
import { ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { SecretBox } from "../secrets.js";
import { recordingAnalytics } from "../test-analytics.js";
import { singleDriver } from "./sandbox-driver.js";
import { SANDBOX_PROVISIONED_EVENT } from "./sandbox-metrics.js";
import { SANDBOX_UNAVAILABLE_MESSAGE, SandboxProvisionError, provisionWorkspace } from "./sandbox-provision.js";

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
  // The stub says it made the machine, and the card had no row: a cold start.
  assert.equal(result.origin, "new");
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
  // Fly's concurrent sprite limit, as the SDK reports it without an
  // error code: the one failure an operator wants an alert on.
  const outOfSprites = new Error('Failed to create sprite (status 429): {"error":"concurrent_sprite_limit_exceeded"}\nmore detail');
  const sprite = stubDriver("sprite", asked, { fail: outOfSprites });
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
  // The transcript never names a provider; the log and error tracking do.
  assert.deepEqual(said, ["Failed to provision sandbox, retrying."]);

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
  assert.equal(fallbackErrors[0]?.error, outOfSprites);
  assert.equal(fallbackErrors[0]?.properties?.source, "sandbox_provision_fallback");
  assert.equal(fallbackErrors[0]?.properties?.provider, "sprite");
  assert.equal(fallbackErrors[0]?.properties?.next_provider, "modal");
  assert.equal(fallbackErrors[0]?.properties?.error_kind, "capacity");
});

test("a project that named its provider fails plainly instead of moving", async () => {
  const featureId = await seedFeature("Pinned to Fly");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("sprites API returned 503") });
  const before = provisionEvents().length;

  // One provider asked and failed is still the generic sentence: the
  // run record never says which provider was behind the card.
  await assert.rejects(provisionOn(featureId, sprite, [], said), (err: unknown) => {
    assert.ok(err instanceof SandboxProvisionError);
    assert.equal(err.message, SANDBOX_UNAVAILABLE_MESSAGE);
    assert.equal(err.blame, "provider");
    assert.match((err.cause as Error).message, /sprites API returned 503/);
    return true;
  });

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

  // The run's error is one generic sentence that names no provider.
  // Both attempts, with their reasons, ride on the error for the log
  // and error tracking.
  await assert.rejects(provisionOn(featureId, sprite, [modal], said), (err: unknown) => {
    assert.ok(err instanceof SandboxProvisionError);
    assert.equal(err.message, SANDBOX_UNAVAILABLE_MESSAGE);
    assert.equal(err.blame, "provider");
    assert.deepEqual(err.failures.map((f) => f.provider), ["sprite", "modal"]);
    assert.deepEqual(err.describeFailures(), ["sprite: sprite failed", "modal: modal failed"]);
    assert.equal((err.cause as Error).message, "modal failed");
    return true;
  });

  assert.deepEqual(asked, ["sprite", "modal"]);
  assert.deepEqual(said, ["Failed to provision sandbox, retrying."]);
  assert.equal(provisionEvents().length, before);
  const fallbackErrors = analytics.exceptions.slice(exceptionsBefore);
  assert.equal(fallbackErrors.length, 1);
  assert.equal(fallbackErrors[0]?.error.message, "sprite failed");
  assert.equal(fallbackErrors[0]?.properties?.error_kind, "other");
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

test("a card whose machine predates the lock keeps its open network, and says so", async () => {
  const featureId = await seedFeature("Locked after the fact");
  const asked: string[] = [];
  const said: string[] = [];
  const networks: (string | undefined)[] = [];
  const sprite = {
    ...stubDriver("sprite", asked),
    async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
      asked.push("sprite");
      networks.push(spec.network);
      return { externalId: `sprite-${spec.workspaceKey}`, provider: "sprite", workdir: "/workspace" };
    },
  } as SandboxDriver;

  const result = await provisionWorkspace(ctx, {
    driver: sprite,
    fallbackDrivers: [],
    selection: "existing",
    projectId,
    organizationId: null,
    workspaceKey: featureId,
    branch: `bento/${featureId}`,
    repoRows: [],
    authMounts: [],
    restrictNetwork: true,
    owner: { featureId },
    say: async (text) => {
      said.push(text);
    },
  });

  assert.equal(result.driver, sprite);
  assert.deepEqual(asked, ["sprite"]);
  assert.deepEqual(networks, [undefined]);
  assert.deepEqual(said, [
    "This card's sandbox was made before the team locked its network, so it keeps the network it started with. New cards run locked down.",
  ]);
});

test("a failure the driver blames on the project ends the run and keeps the sprite, instead of trying Modal", async () => {
  const featureId = await seedFeature("Bad clone, project's fault");
  const asked: string[] = [];
  const said: string[] = [];
  const destroyed: string[] = [];
  const refused = new ProvisionFailure(
    "sprite",
    "checkout",
    "project",
    Object.assign(new Error("provisioning script failed with exit code 128"), { stderr: "fatal: repository not found" }),
  );
  const sprite = stubDriver("sprite", asked, { fail: refused, destroyed });
  const modal = stubDriver("modal", asked, { restricted: true });

  // The project's failure is shown in git's words, since that is what
  // the person has to fix; only the provider's is made generic.
  await assert.rejects(provisionOn(featureId, sprite, [modal], said), (err: unknown) => {
    assert.ok(err instanceof SandboxProvisionError);
    assert.equal(err.blame, "project");
    assert.equal(err.cause, refused);
    assert.match(err.message, /exit code 128/);
    assert.deepEqual(err.describeFailures(), ["sprite checkout (project): provisioning script failed with exit code 128"]);
    return true;
  });
  assert.deepEqual(asked, ["sprite"], "Modal would refuse the same clone, so it is not asked");
  assert.deepEqual(destroyed, [], "the sprite stays for the retry to reuse by name");
  assert.deepEqual(said, []);
});

test("a failure the driver blames on the provider moves on to Modal, with its phase recorded", async () => {
  const featureId = await seedFeature("Control plane down, Fly's fault");
  const asked: string[] = [];
  const said: string[] = [];
  const destroyed: string[] = [];
  const exceptionsBefore = analytics.exceptions.length;
  const down = new ProvisionFailure("sprite", "acquire", "provider", new Error("Network error: fetch failed"));
  const sprite = stubDriver("sprite", asked, { fail: down, destroyed });
  const modal = stubDriver("modal", asked, { restricted: true });

  const result = await provisionOn(featureId, sprite, [modal], said);

  assert.equal(result.driver, modal);
  assert.deepEqual(asked, ["sprite", "modal"]);
  assert.deepEqual(destroyed, [spriteName(featureId)]);
  assert.deepEqual(said, ["Failed to provision sandbox, retrying."]);
  const recorded = analytics.exceptions.slice(exceptionsBefore);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.error.message, "Network error: fetch failed", "error tracking gets the cause, not the wrapper");
  assert.equal(recorded[0]?.properties?.phase, "acquire");
  assert.equal(recorded[0]?.properties?.blame, "provider");
});

test("a clone URL the server cannot reach fails the run before any provider is asked", async () => {
  const featureId = await seedFeature("Unreachable remote");
  const asked: string[] = [];
  const said: string[] = [];
  const [row] = await ctx.db
    .insert(repositories)
    .values({ projectId, name: "ghost", localPath: "/nowhere/ghost", repoUrl: "file:///nonexistent/ghost.git", defaultBranch: "main", position: 0 })
    .returning();
  const sprite = stubDriver("sprite", asked);
  const modal = stubDriver("modal", asked, { restricted: true });

  await assert.rejects(
    provisionWorkspace(ctx, {
      driver: sprite,
      fallbackDrivers: [modal],
      selection: "auto",
      projectId,
      organizationId: null,
      workspaceKey: featureId,
      branch: `bento/${featureId}`,
      repoRows: [row!],
      authMounts: [],
      restrictNetwork: false,
      owner: { featureId },
      say: async (text) => {
        said.push(text);
      },
    }),
    /Repository ghost cannot be reached at file:\/\/\/nonexistent\/ghost\.git/,
  );
  assert.deepEqual(asked, [], "no machine is made for a repository nobody can reach");
  assert.deepEqual(said, []);
});

test("a clone URL the server can reach passes the check and the drivers are asked", async () => {
  const featureId = await seedFeature("Reachable remote");
  const asked: string[] = [];
  const [row] = await ctx.db
    .insert(repositories)
    .values({ projectId, name: "self", localPath: "/home/user/bento", repoUrl: `file://${process.cwd().replace(/\/apps\/server$/, "")}`, defaultBranch: "main", position: 1 })
    .returning();
  const sprite = stubDriver("sprite", asked);

  const result = await provisionWorkspace(ctx, {
    driver: sprite,
    fallbackDrivers: [],
    selection: "auto",
    projectId,
    organizationId: null,
    workspaceKey: featureId,
    branch: `bento/${featureId}`,
    repoRows: [row!],
    authMounts: [],
    restrictNetwork: false,
    owner: { featureId },
    say: async () => {},
  });
  assert.equal(result.driver, sprite);
  assert.deepEqual(asked, ["sprite"]);
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

test("a sprite that failed is destroyed by name when the loop moves on to Modal, whatever the failure", async () => {
  // A plain error, not a leak report: the driver cannot always know
  // whether a create that errored made the machine, so the sprite is
  // destroyed by its workspace name on any failure that moves on.
  const featureId = await seedFeature("Sprite failed, Modal next");
  const asked: string[] = [];
  const said: string[] = [];
  const destroyed: string[] = [];
  const sprite = stubDriver("sprite", asked, { fail: new Error("tool install failed"), destroyed });
  const modal = stubDriver("modal", asked, { restricted: true });

  const result = await provisionOn(featureId, sprite, [modal], said);

  assert.equal(result.driver, modal);
  assert.deepEqual(asked, ["sprite", "modal"]);
  assert.deepEqual(destroyed, [spriteName(featureId)]);
  assert.equal(destroyed[0], `bento-${featureId}`);
  assert.deepEqual(said, ["Failed to provision sandbox, retrying."]);
  const [row] = await ctx.db.select().from(sandboxes).where(eq(sandboxes.featureId, featureId));
  assert.equal(row?.provider, "modal");
});

test("a sprite that failed is kept when it was the last driver, for the retry to reuse by name", async () => {
  const featureId = await seedFeature("Sprite failed, nothing next");
  const asked: string[] = [];
  const said: string[] = [];
  const destroyed: string[] = [];
  const failure = new Error("clone failed");
  const sprite = stubDriver("sprite", asked, { fail: failure, destroyed });

  await assert.rejects(provisionOn(featureId, sprite, [], said), (err: unknown) => {
    assert.ok(err instanceof SandboxProvisionError);
    assert.equal(err.cause, failure);
    return true;
  });
  assert.deepEqual(asked, ["sprite"]);
  assert.deepEqual(destroyed, []);
});

test("a destroy that fails does not stop the fallback", async () => {
  const featureId = await seedFeature("Sprite failed, destroy failed");
  const asked: string[] = [];
  const said: string[] = [];
  const sprite = {
    ...stubDriver("sprite", asked, { fail: new Error("sprite failed") }),
    async destroy() {
      throw new Error("control plane is down");
    },
  } as SandboxDriver;
  const modal = stubDriver("modal", asked, { restricted: true });

  const result = await provisionOn(featureId, sprite, [modal], said);
  assert.equal(result.driver, modal);
  assert.deepEqual(asked, ["sprite", "modal"]);
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

  await assert.rejects(provisionOn(featureId, sprite, [host], said), (err: unknown) => {
    assert.ok(err instanceof SandboxProvisionError);
    assert.match((err.cause as Error).message, /sprite failed/);
    return true;
  });
  assert.deepEqual(asked, ["sprite"]);
});
