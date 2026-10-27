import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { createDb, POOL_CONNECTION_TIMEOUT_MS, poolMaxForRuns } from "@bento/db";
import { CLOUD_POOL_MAX, createCloudPool } from "./cloud-pool.js";

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
