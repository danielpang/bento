import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createDb, POOL_CONNECTION_TIMEOUT_MS, POOL_IDLE_TIMEOUT_MS, POOL_QUERY_TIMEOUT_MS, poolMaxForRuns, type Db } from "@bento/db";
import { CLOUD_POOL_MAX, createCloudPool } from "./cloud-pool.js";
import { startServer } from "./server.js";

/**
 * The plan lookup must not check out from the pool the request
 * transaction is holding.
 *
 * A pool of one is the web process's pool in miniature: the tenant
 * transaction takes the only client, and a query on that same pool
 * waits until the connection timeout. That is the burst behind the
 * organization_plans timeouts, the tenant-transaction timeouts, and
 * "Failed to get session". The cloud pool is a different set of
 * clients, so the lookup answers while the request still holds its
 * client.
 */
const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";

test("the cloud pool is a small pool from the shared factory", async () => {
  const pool = createCloudPool(url);
  try {
    assert.equal(pool.options.max, CLOUD_POOL_MAX);
    assert.ok(CLOUD_POOL_MAX < poolMaxForRuns(0), "smaller than the web process app pool, which is what deadlocks");
    assert.equal(pool.options.connectionTimeoutMillis, POOL_CONNECTION_TIMEOUT_MS);
  } finally {
    await pool.end();
  }
});

test("a second checkout on the pool a transaction holds times out", async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 400 });
  const db = createDb(pool);
  try {
    await assert.rejects(
      () =>
        db.transaction(async () => {
          // The root handle, not the transaction handle: a new client.
          await db.execute(sql`select 1`);
        }),
      (err: unknown) => {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
        const message = err instanceof Error ? err.message : String(err);
        assert.match(`${message}\n${cause}`, /timeout exceeded when trying to connect/);
        return true;
      },
    );
  } finally {
    await pool.end();
  }
});

test("a query on the cloud pool answers while the app pool's only client is held", async () => {
  const appPool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 400 });
  const cloudPool = createCloudPool(url);
  const appDb = createDb(appPool);
  const cloudDb = createDb(cloudPool);
  const started = Date.now();
  try {
    await appDb.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      const result = await cloudDb.execute(sql`select 1 as ok`);
      assert.equal(Number((result.rows[0] as { ok: number } | undefined)?.ok), 1);
    });
    assert.ok(Date.now() - started < 2000, "the lookup must not wait out a connection timeout");
  } finally {
    await cloudPool.end();
    await appPool.end();
  }
});

const cloudDbKey = "__bentoCloudDbUnderTest";

test("registerCloud receives the cloud pool, not the request pool", async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS cloud_pool_boot WITH (FORCE)");
  await admin.query("CREATE DATABASE cloud_pool_boot");
  await admin.end();
  const bootUrl = url.replace(/\/[^/]+$/, "/cloud_pool_boot");
  const dir = await mkdtemp(path.join(tmpdir(), "bento-cloud-module-"));
  const modulePath = path.join(dir, "module.mjs");
  await writeFile(modulePath, `
    export async function registerCloud(host) {
      globalThis.${cloudDbKey} = host.db;
      return {};
    }
  `);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let handed: (Db & { $client: pg.Pool }) | undefined;
  let ready = false;
  try {
    server = await startServer({
      quiet: true,
      migrate: true,
      env: {
        BENTO_MODE: "multi",
        BENTO_ROLE: "web",
        BENTO_MAX_CONCURRENT_RUNS: "",
        PORT: "0",
        DATABASE_URL: bootUrl,
        BENTO_DIRECT_DATABASE_URL: "",
        BENTO_DATA_DIR: dir,
        BENTO_SANDBOX_DRIVER: "local-process",
        BENTO_SECRET_KEY: "test-encryption-key-at-least-32-chars",
        BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
        BETTER_AUTH_URL: "http://localhost:4400",
        BENTO_CLOUD_MODULE: modulePath,
        BENTO_RATE_LIMIT: "false",
        POSTHOG_API_KEY: "",
        POSTHOG_HOST: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
      },
    });
    handed = (globalThis as Record<string, unknown>)[cloudDbKey] as (Db & { $client: pg.Pool }) | undefined;
    assert.ok(handed, "the cloud module was not handed a database");
    const pool = handed.$client;
    assert.equal(pool.options.max, CLOUD_POOL_MAX);
    assert.notEqual(pool.options.max, poolMaxForRuns(0), "the app pool on the web process is larger than the cloud pool");
    assert.equal(pool.options.connectionTimeoutMillis, POOL_CONNECTION_TIMEOUT_MS);
    assert.equal(pool.options.idleTimeoutMillis, POOL_IDLE_TIMEOUT_MS);
    assert.equal(pool.options.query_timeout, POOL_QUERY_TIMEOUT_MS);
    const result = await handed.execute(sql`select 1 as ok`);
    assert.equal(Number((result.rows[0] as { ok: number } | undefined)?.ok), 1);
    // Boot refreshes the model catalog on the app pool without awaiting
    // it. Stop once that write has committed, or shutdown closes the
    // pool under the insert.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const stored = await handed.execute(sql`select 1 from model_catalog_snapshots where id = 'current'`);
      if (stored.rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ready = true;
  } finally {
    delete (globalThis as Record<string, unknown>)[cloudDbKey];
    await server?.stop();
  }
  assert.equal(ready && handed?.$client.ended, true, "shutdown closes the cloud pool");
});
