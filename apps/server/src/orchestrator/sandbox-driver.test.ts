import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb, createPool } from "@bento/db";
import { createApp } from "../app.js";
import { createDrivers, type AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { driverForProject, driverForSandbox } from "./sandbox-driver.js";

/**
 * Registry resolution. Constructors do not open a socket: DockerDriver
 * only builds a client, and SpriteDriver only stores the token.
 */
function driversFor(overrides: NodeJS.ProcessEnv) {
  return createDrivers(loadEnv(overrides));
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

test("a sprite row stays on sprite when modal is also registered, and a project still uses the default", () => {
  const drivers = driversFor({
    BENTO_SANDBOX_DRIVER: "docker",
    SPRITES_TOKEN: "test-token",
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "secret",
  });
  assert.equal(driverForSandbox(drivers, { provider: "sprite" }), drivers.get("sprite"));
  assert.equal(driverForSandbox(drivers, { provider: "modal" }), drivers.get("modal"));
  assert.notEqual(driverForSandbox(drivers, { provider: "modal" }), drivers.default);
  assert.equal(driverForProject(drivers), drivers.default);
  assert.equal(driverForProject(drivers).provider, "docker");
  assert.deepEqual(drivers.selectable(), ["sprite", "modal"]);
});

test("modal is selectable only when both token vars are set", () => {
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
  assert.equal(driverForProject(both).provider, "docker");
});

test("migration 0029 adds a nullable project sandbox provider", () => {
  const sql = readFileSync(new URL("../../../../packages/db/migrations/0029_project_sandbox_provider.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN sandbox_provider text/);
  assert.match(sql, /CHECK \(sandbox_provider IN \('sprite', 'modal', 'docker'\)\)/);
  assert.doesNotMatch(sql, /NOT NULL/);
  const journal = readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8");
  assert.match(journal, /"tag": "0029_project_sandbox_provider"/);
});

test("driverForProject returns the default even when sprite is also registered", () => {
  const drivers = driversFor({ BENTO_SANDBOX_DRIVER: "docker", SPRITES_TOKEN: "test-token" });
  assert.equal(driverForProject(drivers), drivers.default);
  assert.equal(driverForProject(drivers).provider, "docker");
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
