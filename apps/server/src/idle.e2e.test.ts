/**
 * Multi-mode idle harness.
 *
 * Neon suspends after five minutes with no statements. This boots the
 * real multi-mode server (BullMQ, no pg-boss), waits out boot
 * reconciliation, then sits longer than that window and asserts the
 * app issued no SQL while Redis workers stayed blocked.
 *
 * Override the wait with BENTO_IDLE_WINDOW_MS when debugging. The
 * default is six minutes: that is the production gate, not a smoke.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Redis from "ioredis";
import pg from "pg";
import { runMigrations } from "@bento/db";
import { testRedisUrl } from "./jobs/test-queue.js";
import { startServer } from "./server.js";

export const NEON_SUSPEND_WINDOW_MS = 5 * 60_000;
export const DEFAULT_IDLE_HARNESS_MS = 6 * 60_000;

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "idle_multi_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);
const REDIS_URL = testRedisUrl();
const RUNBOOK = path.join(fileURLToPath(new URL("../../../docs/multi-queue-production.md", import.meta.url)));

const BLOCKING_REDIS_CMDS = new Set([
  "bzpopmin",
  "bzpopmax",
  "brpop",
  "blpop",
  "brpoplpush",
  "blmove",
  "blmpop",
  "bzmpop",
  "xread",
  "xreadgroup",
  "subscribe",
  "psubscribe",
  "ssubscribe",
]);

function idleWindowMs(): number {
  const raw = process.env.BENTO_IDLE_WINDOW_MS?.trim();
  if (!raw) return DEFAULT_IDLE_HARNESS_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_HARNESS_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryText(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "text" in arg && typeof (arg as { text: unknown }).text === "string") {
    return (arg as { text: string }).text;
  }
  return String(arg);
}

/**
 * Counts statements that reach the isolated test database. startServer
 * owns its pool, so the counter sits on Client.query and filters by
 * database name. The admin connection stays on `app` and is invisible.
 */
function installStatementCounter(database: string): { statements: string[]; restore: () => void } {
  const statements: string[] = [];
  const original = pg.Client.prototype.query;
  function patched(this: pg.Client, query: unknown, ...rest: unknown[]) {
    if (this.database === database) statements.push(queryText(query));
    return (original as (...args: unknown[]) => unknown).apply(this, [query, ...rest]);
  }
  pg.Client.prototype.query = patched as typeof original;
  return {
    statements,
    restore() {
      pg.Client.prototype.query = original;
    },
  };
}

async function waitUntilQuiet(statements: string[], quietMs: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = statements.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(200);
    if (statements.length !== last) {
      last = statements.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
  }
  throw new Error(`boot reconciliation did not go quiet: ${statements.slice(-8).join(" | ")}`);
}

/** Daily Modal and grant cleanup fire at 09:00 UTC. Do not start the idle window across that minute. */
function msUntilAfterDailyCron(): number {
  const now = Date.now();
  const next = new Date(now);
  next.setUTCHours(9, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() + 45_000 - now;
}

async function skipDailyCronIfNeeded(idleMs: number): Promise<void> {
  const untilAfter = msUntilAfterDailyCron();
  if (untilAfter < idleMs + 30_000) await sleep(untilAfter);
}

type RedisClientRow = { id: string; flags: string; cmd: string };

function parseClientList(raw: string): RedisClientRow[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fields = Object.fromEntries(
        line.split(" ").map((part) => {
          const cut = part.indexOf("=");
          return cut === -1 ? [part, ""] : [part.slice(0, cut), part.slice(cut + 1)];
        }),
      );
      return { id: fields.id ?? "", flags: fields.flags ?? "", cmd: (fields.cmd ?? "").toLowerCase() };
    });
}

function isBlockedWorker(row: RedisClientRow): boolean {
  return row.flags.includes("b") || BLOCKING_REDIS_CMDS.has(row.cmd);
}

async function blockedRedisClients(redis: Redis): Promise<RedisClientRow[]> {
  return parseClientList(await redis.client("LIST")).filter(isBlockedWorker);
}

async function recreateTestDb(): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${testDbName}`);
  } finally {
    await admin.end();
  }
}

test("the idle harness waits longer than Neon's suspend window", () => {
  assert.equal(NEON_SUSPEND_WINDOW_MS, 5 * 60_000);
  assert.ok(DEFAULT_IDLE_HARNESS_MS > NEON_SUSPEND_WINDOW_MS);
});

test("the production runbook covers Redis, isolation, AOF, cutover, and local pg-boss", () => {
  const src = readFileSync(RUNBOOK, "utf8");
  for (const needle of [
    "AOF",
    "bento:production",
    "BENTO_ENVIRONMENT",
    "active_time",
    "pg-boss",
    "Mac app",
    "Rollback",
    "REDIS_URL",
    "about 20 Redis connections",
    "iad",
    "owner",
    "maxRetriesPerRequest",
    "hosted-drop-pgboss.sql",
    "irreversible without restore",
    "BENTO_IDLE_WINDOW_MS",
  ]) {
    assert.match(src, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `runbook is missing ${needle}`);
  }
});

const idleMs = idleWindowMs();

test("multi mode issues no Postgres statements past the Neon suspend window", { timeout: idleMs + 8 * 60_000 }, async () => {
  await recreateTestDb();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-idle-"));
  const secret = "a".repeat(64);
  const server = await startServer({
    quiet: true,
    migrate: false,
    env: {
      BENTO_MODE: "multi",
      BENTO_ENVIRONMENT: "production",
      DATABASE_URL: testUrl,
      REDIS_URL,
      BENTO_DATA_DIR: dataDir,
      BENTO_SANDBOX_DRIVER: "local-process",
      BENTO_SECRET_KEY: secret,
      BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
      BENTO_HOST: "127.0.0.1",
      PORT: "0",
      POSTHOG_API_KEY: "",
      BENTO_CLOUD_MODULE: "",
    },
  });
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const counter = installStatementCounter(testDbName);
  try {
    assert.equal(server.mode, "multi");
    await waitUntilQuiet(counter.statements, 5_000);
    await skipDailyCronIfNeeded(idleMs);
    await waitUntilQuiet(counter.statements, 2_000);

    const blockedBefore = await blockedRedisClients(redis);
    assert.ok(
      blockedBefore.length >= 8,
      `Redis workers should block after boot, saw ${blockedBefore.length} blocked clients`,
    );
    const blockedIds = new Set(blockedBefore.map((row) => row.id));

    counter.statements.length = 0;
    await sleep(idleMs);

    assert.deepEqual(
      counter.statements,
      [],
      `Postgres was queried during the idle window:\n${counter.statements.join("\n")}`,
    );

    const blockedAfter = await blockedRedisClients(redis);
    const stillBlocked = blockedAfter.filter((row) => blockedIds.has(row.id));
    assert.ok(
      stillBlocked.length >= Math.ceil(blockedIds.size * 0.8),
      `Redis workers stopped blocking during idle: ${stillBlocked.length} of ${blockedIds.size} still blocked`,
    );

    const health = await fetch(`${server.url}/api/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { ok: boolean; mode: string };
    assert.equal(body.ok, true);
    assert.equal(body.mode, "multi");
    assert.deepEqual(counter.statements, [], "shallow /api/health queried Postgres");
  } finally {
    counter.restore();
    await redis.quit().catch(() => {});
    await server.stop();
  }
});
