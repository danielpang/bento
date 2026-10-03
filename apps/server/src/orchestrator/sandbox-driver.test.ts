import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createDb,
  createPool,
  features,
  pipelines,
  projects,
  runMigrations,
  sandboxes,
  swarms,
} from "@bento/db";
import pg from "pg";
import { createApp } from "../app.js";
import { createDrivers, ensureLocalUser, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { FeatureFlags } from "../feature-flags.js";
import {
  autoDrivers,
  driverForProject,
  driverForProvision,
  driverForSandbox,
  driverForSwarmProvision,
  driversForProject,
  driversForProvision,
} from "./sandbox-driver.js";

/**
 * Registry resolution. Constructors do not open a socket: DockerDriver
 * only builds a client, and SpriteDriver only stores the token.
 */
function driversFor(overrides: NodeJS.ProcessEnv) {
  return createDrivers(loadEnv(overrides));
}

/** A project with no setting, or one that names the default, never asks the flag. */
function projectDriver(drivers: ReturnType<typeof driversFor>, sandboxProvider: string | null = null) {
  return driverForProject(
    { drivers, env: { BENTO_MODE: "local" } } as AppContext,
    { sandboxProvider, ownerId: "owner" },
    null,
  );
}

test("a sprite row resolves to sprite when the default is docker and both are registered", () => {
  const drivers = driversFor({ BENTO_SANDBOX_DRIVER: "docker", SPRITES_TOKEN: "test-token" });
  const sprite = drivers.get("sprite");
  assert.ok(sprite);
  assert.equal(drivers.default.provider, "docker");
  assert.equal(sprite.provider, "sprite");
  assert.notEqual(driverForSandbox(drivers, { provider: "sprite" }), drivers.default);
  assert.equal(driverForSandbox(drivers, { provider: "sprite" }), sprite);
  assert.equal(driverForSandbox(drivers, { provider: "docker" }), drivers.default);
  assert.deepEqual(drivers.selectable(), ["sprite"]);
});

test("a docker row on a local-process default resolves to local-process", () => {
  const drivers = driversFor({ BENTO_SANDBOX_DRIVER: "local-process" });
  assert.equal(drivers.default.provider, "local-process");
  const resolved = driverForSandbox(drivers, { provider: "docker" });
  assert.equal(resolved, drivers.default);
  assert.equal(resolved.provider, "local-process");
});

test("an unconfigured provider throws and does not fall through to the default", () => {
  const drivers = driversFor({ BENTO_SANDBOX_DRIVER: "docker" });
  assert.equal(drivers.default.provider, "docker");
  assert.equal(drivers.get("sprite"), undefined);
  assert.throws(
    () => driverForSandbox(drivers, { provider: "sprite" }),
    /no sprite driver configured on this server/,
  );
  assert.throws(
    () => driverForSandbox(drivers, { provider: "modal" }),
    /no modal driver configured on this server/,
  );
});

test("a sprite row stays on sprite when modal is also registered, and a project with no setting uses the default", async () => {
  const drivers = driversFor({
    BENTO_SANDBOX_DRIVER: "docker",
    SPRITES_TOKEN: "test-token",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
  });
  assert.equal(driverForSandbox(drivers, { provider: "sprite" }), drivers.get("sprite"));
  assert.equal(driverForSandbox(drivers, { provider: "modal" }), drivers.get("modal"));
  assert.notEqual(driverForSandbox(drivers, { provider: "modal" }), drivers.default);
  assert.equal(await projectDriver(drivers), drivers.default);
  assert.equal((await projectDriver(drivers)).provider, "docker");
  assert.equal(await projectDriver(drivers, "docker"), drivers.default);
  assert.deepEqual(drivers.selectable(), ["sprite", "modal"]);
});

test("modal is selectable only when both token vars are set", async () => {
  assert.equal(driversFor({ BENTO_SANDBOX_DRIVER: "docker", MODAL_TOKEN_ID: "id" }).get("modal"), undefined);
  assert.equal(driversFor({ BENTO_SANDBOX_DRIVER: "docker", MODAL_TOKEN_SECRET: "secret" }).get("modal"), undefined);
  const both = driversFor({
    BENTO_SANDBOX_DRIVER: "docker",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
    MODAL_ENVIRONMENT: "bento-development",
    MODAL_SANDBOX_CPU: "1",
    MODAL_SANDBOX_MEMORY_MIB: "2048",
  });
  assert.equal(both.default.provider, "docker");
  assert.equal(both.get("modal")?.provider, "modal");
  assert.equal(both.get("modal")?.sandboxSize, "modal-small");
  assert.deepEqual(both.selectable(), ["modal"]);
  assert.equal((await projectDriver(both)).provider, "docker");
});

test("migration 0044 adds a nullable project sandbox provider", () => {
  const sql = readFileSync(new URL("../../../../packages/db/migrations/0044_project_sandbox_provider.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN sandbox_provider text/);
  assert.match(sql, /CHECK \(sandbox_provider IN \('sprite', 'modal', 'docker'\)\)/);
  assert.doesNotMatch(sql, /NOT NULL/);
  const journal = readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8");
  assert.match(journal, /"tag": "0044_project_sandbox_provider"/);
});

test("auto is a sprite with Modal behind it, Modal alone without a sprite, and the default with neither", async () => {
  const ctxFor = (drivers: ReturnType<typeof driversFor>) =>
    ({ drivers, env: { BENTO_MODE: "local" } }) as AppContext;
  const auto = { sandboxProvider: "auto", ownerId: "owner" };

  const both = driversFor({
    BENTO_SANDBOX_DRIVER: "docker",
    SPRITES_TOKEN: "test-token",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
  });
  assert.deepEqual(autoDrivers(both).map((d) => d.provider), ["sprite", "modal"]);
  const onBoth = await driversForProject(ctxFor(both), auto, null);
  assert.equal(onBoth.driver, both.get("sprite"));
  assert.deepEqual(onBoth.fallbacks, [both.get("modal")]);
  assert.equal(onBoth.selection, "auto");
  assert.equal(await driverForProject(ctxFor(both), auto, null), both.get("sprite"));

  const modalOnly = driversFor({ BENTO_SANDBOX_DRIVER: "docker", MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" });
  const onModal = await driversForProject(ctxFor(modalOnly), auto, null);
  assert.equal(onModal.driver, modalOnly.get("modal"));
  assert.deepEqual(onModal.fallbacks, []);
  assert.equal(onModal.selection, "auto");

  const neither = driversFor({ BENTO_SANDBOX_DRIVER: "docker" });
  assert.deepEqual(autoDrivers(neither), []);
  const onNeither = await driversForProject(ctxFor(neither), auto, null);
  assert.equal(onNeither.driver, neither.default);
  assert.deepEqual(onNeither.fallbacks, []);
  assert.equal(onNeither.selection, "default");

  // A hosted deployment whose default is already the sprite: auto is
  // the same sprite, now with Modal behind it.
  const hosted = driversFor({
    BENTO_SANDBOX_DRIVER: "sprite",
    SPRITES_TOKEN: "test-token",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
  });
  const onHosted = await driversForProject(ctxFor(hosted), auto, null);
  assert.equal(onHosted.driver, hosted.default);
  assert.equal(onHosted.driver.provider, "sprite");
  assert.deepEqual(onHosted.fallbacks.map((d) => d.provider), ["modal"]);
  assert.equal(onHosted.selection, "auto");

  // A named provider and the default carry no fallback.
  const named = await driversForProject(ctxFor(both), { sandboxProvider: "modal", ownerId: "owner" }, null);
  assert.equal(named.driver, both.get("modal"));
  assert.deepEqual(named.fallbacks, []);
  assert.equal(named.selection, "project");
  const unset = await driversForProject(ctxFor(both), { sandboxProvider: null, ownerId: "owner" }, null);
  assert.equal(unset.driver, both.default);
  assert.deepEqual(unset.fallbacks, []);
  assert.equal(unset.selection, "default");
});

test("migration 0045 lets a project hold auto and starts new rows there", () => {
  const sql = readFileSync(new URL("../../../../packages/db/migrations/0045_project_sandbox_provider_auto.sql", import.meta.url), "utf8");
  assert.match(sql, /DROP CONSTRAINT projects_sandbox_provider_check/);
  assert.match(sql, /CHECK \(sandbox_provider IN \('auto', 'sprite', 'modal', 'docker'\)\)/);
  assert.match(sql, /ALTER COLUMN sandbox_provider SET DEFAULT 'auto'/);
  assert.doesNotMatch(sql, /NOT NULL/);
  const journal = readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8");
  assert.match(journal, /"tag": "0045_project_sandbox_provider_auto"/);
});

test("driverForProject returns the default even when sprite is also registered", async () => {
  const drivers = driversFor({ BENTO_SANDBOX_DRIVER: "docker", SPRITES_TOKEN: "test-token" });
  assert.equal(await projectDriver(drivers), drivers.default);
  assert.equal((await projectDriver(drivers)).provider, "docker");
  assert.equal(await projectDriver(drivers, "docker"), drivers.default);
  assert.ok(drivers.get("sprite"));
});

test("selectable is sprite only when that driver was built", () => {
  assert.deepEqual(driversFor({ BENTO_SANDBOX_DRIVER: "docker" }).selectable(), []);
  assert.deepEqual(driversFor({ BENTO_SANDBOX_DRIVER: "local-process" }).selectable(), []);
  const sprite = driversFor({ BENTO_SANDBOX_DRIVER: "sprite", SPRITES_TOKEN: "test-token" });
  assert.equal(sprite.default.provider, "sprite");
  assert.deepEqual(sprite.selectable(), ["sprite"]);
  const alongside = driversFor({ BENTO_SANDBOX_DRIVER: "local-process", SPRITES_TOKEN: "test-token" });
  assert.equal(alongside.default.provider, "local-process");
  assert.equal(alongside.get("sprite")?.provider, "sprite");
  assert.deepEqual(alongside.selectable(), ["sprite"]);
});

test("a sprite default without a token refuses to start", () => {
  assert.throws(
    () => driversFor({ BENTO_SANDBOX_DRIVER: "sprite" }),
    /BENTO_SANDBOX_DRIVER=sprite needs SPRITES_TOKEN/,
  );
});

test("a hosted sprite config reports driver sprite from health", async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: databaseUrl,
    BENTO_SANDBOX_DRIVER: "sprite",
    SPRITES_TOKEN: "test-token",
  });
  const pool = createPool(databaseUrl);
  try {
    const app = createApp({
      env,
      db: createDb(pool),
      drivers: createDrivers(env),
    } as unknown as AppContext);
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { driver: string; selectableSandboxProviders: string[] };
    assert.equal(body.driver, "sprite");
    assert.deepEqual(body.selectableSandboxProviders, ["sprite"]);
  } finally {
    await pool.end();
  }
});

test("driverForProject ignores a stored modal when beta is off, and a hibernated modal row still resolves to Modal", async () => {
  const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
  const testDbName = "sandbox_driver_provider_test";
  const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  try {
    const ownerId = await ensureLocalUser(db);
    const drivers = driversFor({
      BENTO_SANDBOX_DRIVER: "docker",
      MODAL_TOKEN_ID: "id",
      MODAL_TOKEN_SECRET: "secret",
    });
    const ctx = {
      db,
      drivers,
      env: loadEnv({ BENTO_MODE: "multi", DATABASE_URL: testUrl, BENTO_SANDBOX_DRIVER: "docker" }),
      featureFlags: new FeatureFlags(null, false),
    } as AppContext;

    const featureId = randomUUID();
    const [project] = await db
      .insert(projects)
      .values({ ownerId, name: "Modal when beta is off", sandboxProvider: "modal" })
      .returning();
    assert.equal(await driverForProject(ctx, project!, null), drivers.default);
    assert.equal((await driverForProject(ctx, project!, ownerId)).provider, "docker");

    // A project inserted without a provider starts on auto, and auto
    // does not ask the flag: with beta off it still resolves to the
    // Modal this server runs, the only auto candidate here.
    const [fresh] = await db.insert(projects).values({ ownerId, name: "Fresh project" }).returning();
    assert.equal(fresh?.sandboxProvider, "auto");
    const onAuto = await driversForProject(ctx, fresh!, null);
    assert.equal(onAuto.driver, drivers.get("modal"));
    assert.equal(onAuto.selection, "auto");
    assert.deepEqual(onAuto.fallbacks, []);

    const [pipeline] = await db
      .insert(pipelines)
      .values({ projectId: project!.id, name: "Default", isDefault: true })
      .returning();
    await db.insert(features).values({
      id: featureId,
      projectId: project!.id,
      pipelineId: pipeline!.id,
      title: "Hibernated",
    });
    assert.equal((await driverForProvision(db, ctx, featureId, null)).provider, "docker");

    await db.insert(sandboxes).values({
      projectId: project!.id,
      featureId,
      provider: "modal",
      externalId: `bento-${featureId}`,
      status: "hibernated",
      workdir: "/workspace",
    });
    const resolved = await driverForProvision(db, ctx, featureId, null);
    assert.equal(resolved, drivers.get("modal"));
    assert.equal(resolved.provider, "modal");
    // An existing machine is kept as is, with nothing to fall back to.
    const existing = await driversForProvision(db, ctx, featureId, null);
    assert.equal(existing.selection, "existing");
    assert.deepEqual(existing.fallbacks, []);
  } finally {
    await pool.end();
  }
});

test("a swarm on a modal project uses Modal, and a live Sprite swarm stays on Sprite", async () => {
  const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
  const testDbName = "sandbox_driver_swarm_test";
  const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  try {
    const ownerId = await ensureLocalUser(db);
    const drivers = driversFor({
      BENTO_SANDBOX_DRIVER: "docker",
      SPRITES_TOKEN: "test-token",
      MODAL_TOKEN_ID: "id",
      MODAL_TOKEN_SECRET: "secret",
    });
    const betaOn = {
      db,
      drivers,
      env: loadEnv({ BENTO_MODE: "multi", DATABASE_URL: testUrl, BENTO_SANDBOX_DRIVER: "docker" }),
      featureFlags: new FeatureFlags(null, true),
    } as AppContext;
    const betaOff = { ...betaOn, featureFlags: new FeatureFlags(null, false) } as AppContext;

    const [project] = await db
      .insert(projects)
      .values({ ownerId, name: "Modal swarm", sandboxProvider: "modal" })
      .returning();
    const [swarm] = await db
      .insert(swarms)
      .values({
        projectId: project!.id,
        slug: "modal-swarm",
        title: "Modal swarm",
        goal: "run on modal",
        workerIsolation: "sandbox",
      })
      .returning();

    const fresh = await driverForSwarmProvision(db, betaOn, swarm!, null, ownerId);
    assert.equal(fresh, drivers.get("modal"));
    assert.notEqual(fresh, drivers.default);
    assert.equal(fresh.provider, "modal");

    const ignored = await driverForSwarmProvision(db, betaOff, swarm!, null, ownerId);
    assert.equal(ignored, drivers.default);
    assert.equal(ignored.provider, "docker");

    const [spriteSwarm] = await db
      .insert(swarms)
      .values({
        projectId: project!.id,
        slug: "sprite-swarm",
        title: "Sprite swarm",
        goal: "stay on sprite",
        workerIsolation: "sandbox",
      })
      .returning();
    const [spriteRow] = await db
      .insert(sandboxes)
      .values({
        projectId: project!.id,
        swarmId: spriteSwarm!.id,
        provider: "sprite",
        externalId: `bento-swarm-${spriteSwarm!.id}`,
        status: "ready",
        workdir: "/workspace",
      })
      .returning();
    const kept = await driverForSwarmProvision(
      db,
      betaOn,
      { ...spriteSwarm!, sandboxId: spriteRow!.id },
      null,
      ownerId,
    );
    assert.equal(kept, drivers.get("sprite"));
    assert.equal(kept.provider, "sprite");
    assert.notEqual(kept, drivers.default);
    assert.notEqual(kept, drivers.get("modal"));
  } finally {
    await pool.end();
  }
});
