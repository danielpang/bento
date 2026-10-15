import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type pg from "pg";
import { POOL_QUERY_TIMEOUT_MS, pgBossDatabase } from "./client.js";
import { PG_BOSS_POLL_TIMEOUT_MS, isPgBossPoll, runPgBossPoll } from "./pg-boss-poll.js";

const require = createRequire(import.meta.url);
const plans = require("pg-boss/src/plans.js") as Record<string, (...args: unknown[]) => unknown>;

function plan(name: string, ...args: unknown[]): string {
  const fn = plans[name];
  assert.ok(fn, `pg-boss plans.${name} exists`);
  return fn(...args) as string;
}

function readTimeout(): Error {
  return new Error("Query read timeout");
}

const ok = { rows: [{ ok: true }], rowCount: 1, command: "SELECT", oid: 0, fields: [] } as pg.QueryResult;

test("the poll timeout is shorter than the pool's", () => {
  assert.ok(PG_BOSS_POLL_TIMEOUT_MS < POOL_QUERY_TIMEOUT_MS);
});

test("the installed pg-boss timer statements are recognized as polls", () => {
  const fetch = plan("fetchNextJob", "pgboss") as unknown as (o: object) => string;
  assert.ok(isPgBossPoll(fetch({})));
  assert.ok(isPgBossPoll(fetch({ includeMetadata: true, priority: false, ignoreStartAfter: true })));
  assert.ok(isPgBossPoll(plan("trySetMaintenanceTime", "pgboss")));
  assert.ok(isPgBossPoll(plan("trySetMonitorTime", "pgboss")));
  assert.ok(isPgBossPoll(plan("trySetCronTime", "pgboss")));
  assert.ok(isPgBossPoll(plan("getTime", "pgboss")));
});

test("pg-boss writes and maintenance are not retried", () => {
  for (const sql of [
    plan("insertJob", "pgboss"),
    plan("completeJobs", "pgboss"),
    plan("failJobsById", "pgboss"),
    plan("setVersion", "pgboss", "24"),
    plan("locked", "pgboss", plan("failJobsByTimeout", "pgboss")),
    plan("locked", "pgboss", plan("drop", "pgboss", "7 days")),
    plan("countStates", "pgboss"),
    "select 1",
  ]) {
    assert.equal(isPgBossPoll(sql), false, sql.slice(0, 80));
  }
});

test("a poll that timed out runs once more", async () => {
  const calls: Array<{ text: string; query_timeout: number }> = [];
  const pool = {
    query: async (config: { text: string; query_timeout: number }) => {
      calls.push(config);
      if (calls.length === 1) throw readTimeout();
      return ok;
    },
  } as unknown as pg.Pool;
  const result = await runPgBossPoll(pool, "poll", [1]);
  assert.equal(result, ok);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.query_timeout === PG_BOSS_POLL_TIMEOUT_MS));
});

test("a second timeout, or any other error, goes to pg-boss", async () => {
  let calls = 0;
  const timesOut = {
    query: async () => {
      calls++;
      throw readTimeout();
    },
  } as unknown as pg.Pool;
  await assert.rejects(runPgBossPoll(timesOut, "poll", []), /Query read timeout/);
  assert.equal(calls, 2);

  calls = 0;
  const refused = {
    query: async () => {
      calls++;
      throw new Error("permission denied");
    },
  } as unknown as pg.Pool;
  await assert.rejects(runPgBossPoll(refused, "poll", []), /permission denied/);
  assert.equal(calls, 1, "only a timeout is retried");
});

test("the adapter sends polls through the retry and everything else straight", async () => {
  const seen: unknown[] = [];
  const pool = {
    query: async (...args: unknown[]) => {
      seen.push(args);
      return ok;
    },
  } as unknown as pg.Pool;
  const db = pgBossDatabase(pool, { pollTimeoutMs: 1234 });
  const lease = plan("trySetMaintenanceTime", "pgboss");
  await db.executeSql(lease, [120]);
  await db.executeSql("select 1", []);
  assert.deepEqual(seen, [[{ text: lease, values: [120], query_timeout: 1234 }], ["select 1", []]]);
});
