import assert from "node:assert/strict";
import test from "node:test";
import {
  createPool,
  POOL_CONNECTION_TIMEOUT_MS,
  POOL_IDLE_TIMEOUT_MS,
  POOL_KEEPALIVE_INITIAL_DELAY_MS,
  POOL_MAX_LIFETIME_SECONDS,
  poolMaxForRuns,
  postgresPoolConfig,
} from "@bento/db";

test("a laptop's 4 workers still leave headroom for HTTP", () => {
  assert.equal(poolMaxForRuns(4), 20);
});

test("hosted worker count gets a connection per run plus headroom", () => {
  assert.equal(poolMaxForRuns(32), 48);
});

test("the pool recycles idle clients and probes dead sockets", async () => {
  const pool = createPool("postgres://postgres:postgres@localhost:5432/app", { max: 4 });
  try {
    assert.equal(pool.options.keepAlive, true);
    assert.equal(pool.options.keepAliveInitialDelayMillis, POOL_KEEPALIVE_INITIAL_DELAY_MS);
    assert.equal(pool.options.idleTimeoutMillis, POOL_IDLE_TIMEOUT_MS);
    assert.equal(pool.options.connectionTimeoutMillis, POOL_CONNECTION_TIMEOUT_MS);
    assert.equal(pool.options.maxLifetimeSeconds, POOL_MAX_LIFETIME_SECONDS);
    assert.equal(pool.options.max, 4);
  } finally {
    await pool.end();
  }
});

test("pg-boss receives the same pool options the app pool uses", () => {
  const config = postgresPoolConfig("postgres://postgres:postgres@localhost:5432/app", { max: 16 });
  assert.equal(config.keepAlive, true);
  assert.equal(config.idleTimeoutMillis, POOL_IDLE_TIMEOUT_MS);
  assert.equal(config.connectionTimeoutMillis, POOL_CONNECTION_TIMEOUT_MS);
  assert.equal(config.maxLifetimeSeconds, POOL_MAX_LIFETIME_SECONDS);
  assert.equal(config.max, 16);
});
