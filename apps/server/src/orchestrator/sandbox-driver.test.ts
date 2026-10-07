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
  candidateDrivers,
  driverForProject,
  driverForProvision,
  driverForSandbox,
  driversForProject,
  driversForProvision,
  driversForSwarmProvision,
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

test("auto is the sprite with Modal behind it on a sprite deployment, and the configured driver elsewhere", async () => {
  const ctxFor = (drivers: ReturnType<typeof driversFor>) =>
    ({ drivers, env: { BENTO_MODE: "local" } }) as AppContext;
  const auto = { sandboxProvider: "auto", ownerId: "owner" };

  // The hosted shape: the default is the sprite, Modal is built too.
  const hosted = driversFor({
    BENTO_SANDBOX_DRIVER: "sprite",
    SPRITES_TOKEN: "test-token",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
  });
  assert.deepEqual(autoDrivers(hosted).map((d) => d.provider), ["sprite", "modal"]);
  const onHosted = await driversForProject(ctxFor(hosted), auto, null);
  assert.equal(onHosted.driver, hosted.default);
  assert.equal(onHosted.driver.provider, "sprite");
  assert.deepEqual(onHosted.fallbacks, [hosted.get("modal")]);
  assert.equal(onHosted.selection, "auto");
  assert.equal(await driverForProject(ctxFor(hosted), auto, null), hosted.default);

  // A sprite deployment with no Modal credentials: the sprite, with
  // nothing behind it.
  const spriteOnly = driversFor({ BENTO_SANDBOX_DRIVER: "sprite", SPRITES_TOKEN: "test-token" });
  const onSpriteOnly = await driversForProject(ctxFor(spriteOnly), auto, null);
  assert.equal(onSpriteOnly.driver, spriteOnly.default);
  assert.deepEqual(onSpriteOnly.fallbacks, []);
  assert.equal(onSpriteOnly.selection, "auto");

  // A docker or local-process deployment keeps its configured driver
  // even when it holds the tokens: auto never moves a new project
  // onto a paid machine the operator did not pick.
  for (const defaultDriver of ["docker", "local-process"] as const) {
    const local = driversFor({
      BENTO_SANDBOX_DRIVER: defaultDriver,
      SPRITES_TOKEN: "test-token",
      MODAL_TOKEN_ID: "id",
      MODAL_TOKEN_SECRET: "secret",
    });
    assert.deepEqual(autoDrivers(local).map((d) => d.provider), ["sprite", "modal"]);
    const onLocal = await driversForProject(ctxFor(local), auto, null);
    assert.equal(onLocal.driver, local.default);
    assert.equal(onLocal.driver.provider, defaultDriver);
    assert.deepEqual(onLocal.fallbacks, []);
    assert.equal(onLocal.selection, "default");
  }
  const neither = driversFor({ BENTO_SANDBOX_DRIVER: "docker" });
  assert.deepEqual(autoDrivers(neither), []);
  assert.equal((await driversForProject(ctxFor(neither), auto, null)).selection, "default");

  // A named provider and the default carry no fallback.
  const named = await driversForProject(ctxFor(hosted), { sandboxProvider: "modal", ownerId: "owner" }, null);
  assert.equal(named.driver, hosted.get("modal"));
  assert.deepEqual(named.fallbacks, []);
  assert.equal(named.selection, "project");
  const unset = await driversForProject(ctxFor(hosted), { sandboxProvider: null, ownerId: "owner" }, null);
  assert.equal(unset.driver, hosted.default);
  assert.deepEqual(unset.fallbacks, []);
  assert.equal(unset.selection, "default");
});

test("candidateDrivers is the one reading of a stored setting, shared by the routes", () => {
  const hosted = driversFor({
    BENTO_SANDBOX_DRIVER: "sprite",
    SPRITES_TOKEN: "test-token",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
  });
  const sprite = hosted.get("sprite")!;
  const modal = hosted.get("modal")!;
  assert.deepEqual(candidateDrivers(hosted, null), { driver: sprite, fallbacks: [], selection: "default" });
  assert.deepEqual(candidateDrivers(hosted, "sprite"), { driver: sprite, fallbacks: [], selection: "project" });
  assert.deepEqual(candidateDrivers(hosted, "modal"), { driver: modal, fallbacks: [], selection: "project" });
  assert.deepEqual(candidateDrivers(hosted, "auto"), { driver: sprite, fallbacks: [modal], selection: "auto" });
  // A name this server did not build is the default, not a failed card.
  assert.deepEqual(candidateDrivers(hosted, "docker"), { driver: sprite, fallbacks: [], selection: "default" });

  const local = driversFor({ BENTO_SANDBOX_DRIVER: "docker", MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "secret" });
  assert.deepEqual(candidateDrivers(local, "auto"), { driver: local.default, fallbacks: [], selection: "default" });
  assert.deepEqual(candidateDrivers(local, "modal"), { driver: local.get("modal"), fallbacks: [], selection: "project" });
  assert.deepEqual(candidateDrivers(local, "docker"), { driver: local.default, fallbacks: [], selection: "project" });
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

test("migration 0046 moves every project to auto and keeps the column", () => {
  const sql = readFileSync(new URL("../../../../packages/db/migrations/0046_project_sandbox_provider_always_auto.sql", import.meta.url), "utf8");
  assert.match(sql, /UPDATE projects SET sandbox_provider = 'auto'/);
  assert.doesNotMatch(sql, /DROP COLUMN/);
  const journal = readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8");
  assert.match(journal, /"tag": "0046_project_sandbox_provider_always_auto"/);
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

test("a pinned provider is honored for everyone, and a hibernated modal row still resolves to Modal", async () => {
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
    // A row an operator pinned by hand is honored whether or not the
    // run is on the beta flag: this context has it off.
    const [project] = await db
      .insert(projects)
      .values({ ownerId, name: "Pinned to Modal", sandboxProvider: "modal" })
      .returning();
    assert.equal(await driverForProject(ctx, project!, null), drivers.get("modal"));
    assert.equal((await driverForProject(ctx, project!, ownerId)).provider, "modal");
    const pinned = await driversForProject(ctx, project!, null);
    assert.equal(pinned.selection, "project");
    assert.deepEqual(pinned.fallbacks, []);

    // A project inserted without a provider starts on auto. On this
    // docker deployment that is docker, whatever tokens are set, and
    // the flag is never asked.
    const [fresh] = await db.insert(projects).values({ ownerId, name: "Fresh project" }).returning();
    assert.equal(fresh?.sandboxProvider, "auto");
    const onAuto = await driversForProject(ctx, fresh!, null);
    assert.equal(onAuto.driver, drivers.default);
    assert.equal(onAuto.selection, "default");
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
    assert.equal((await driverForProvision(db, ctx, featureId, null)).provider, "modal");

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

    const fresh = (await driversForSwarmProvision(db, betaOn, swarm!, null, ownerId)).driver;
    assert.equal(fresh, drivers.get("modal"));
    assert.notEqual(fresh, drivers.default);
    assert.equal(fresh.provider, "modal");

    // The pin is not a beta feature: a context with the flag off reads it the same way.
    const alsoModal = (await driversForSwarmProvision(db, betaOff, swarm!, null, ownerId)).driver;
    assert.equal(alsoModal, drivers.get("modal"));
    assert.equal(alsoModal.provider, "modal");

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
    const keptChoice = await driversForSwarmProvision(
      db,
      betaOn,
      { ...spriteSwarm!, sandboxId: spriteRow!.id },
      null,
      ownerId,
    );
    const kept = keptChoice.driver;
    assert.equal(keptChoice.selection, "existing");
    assert.deepEqual(keptChoice.fallbacks, []);
    assert.equal(kept, drivers.get("sprite"));
    assert.equal(kept.provider, "sprite");
    assert.notEqual(kept, drivers.default);
    assert.notEqual(kept, drivers.get("modal"));
  } finally {
    await pool.end();
  }
});
