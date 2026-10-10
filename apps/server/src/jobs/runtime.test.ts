import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type PgBoss from "pg-boss";
import { loadEnv } from "../env.js";
import { PgBossQueue } from "./pg-boss.js";
import {
  createRuntimeJobQueue,
  isValidRedisUrl,
  jobQueueBackend,
  redisUrlForQueue,
  requireRedisUrl,
} from "./runtime.js";

const validRedis = "redis://127.0.0.1:6379";
const leftoverRedis = "redis://leftover.example:6379";

test("local mode and the Mac app always select pg-boss", () => {
  assert.equal(jobQueueBackend(loadEnv({})), "pg-boss");
  assert.equal(jobQueueBackend(loadEnv({ BENTO_MODE: "local" })), "pg-boss");
  assert.equal(
    jobQueueBackend(loadEnv({ BENTO_MODE: "local", REDIS_URL: leftoverRedis })),
    "pg-boss",
  );
  // Desktop and TUI force local, the same way the Mac app does.
  assert.equal(jobQueueBackend({ BENTO_MODE: "local" }), "pg-boss");
});

test("multi mode always selects BullMQ, even when REDIS_URL is missing", () => {
  assert.equal(jobQueueBackend(loadEnv({ BENTO_MODE: "multi" })), "bullmq");
  assert.equal(
    jobQueueBackend(loadEnv({ BENTO_MODE: "multi", REDIS_URL: validRedis })),
    "bullmq",
  );
  assert.equal(
    jobQueueBackend(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "not-a-url" })),
    "bullmq",
  );
});

test("redisUrlForQueue is null in local mode even with a leftover URL", () => {
  assert.equal(redisUrlForQueue(loadEnv({ BENTO_MODE: "local", REDIS_URL: leftoverRedis })), null);
  assert.equal(redisUrlForQueue(loadEnv({})), null);
  assert.equal(redisUrlForQueue(loadEnv({ BENTO_MODE: "local", REDIS_URL: "" })), null);
});

test("redisUrlForQueue returns the trimmed URL only in multi mode", () => {
  assert.equal(redisUrlForQueue(loadEnv({ BENTO_MODE: "multi" })), null);
  assert.equal(redisUrlForQueue(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "   " })), null);
  assert.equal(
    redisUrlForQueue(loadEnv({ BENTO_MODE: "multi", REDIS_URL: `  ${validRedis}  ` })),
    validRedis,
  );
});

test("isValidRedisUrl accepts redis and rediss URLs with a host", () => {
  assert.equal(isValidRedisUrl("redis://127.0.0.1:6379"), true);
  assert.equal(isValidRedisUrl("redis://:secret@redis.example:6379/0"), true);
  assert.equal(isValidRedisUrl("rediss://cache.example:6380"), true);
  assert.equal(isValidRedisUrl("not-a-url"), false);
  assert.equal(isValidRedisUrl("http://127.0.0.1:6379"), false);
  assert.equal(isValidRedisUrl("postgres://127.0.0.1:5432/app"), false);
  assert.equal(isValidRedisUrl("redis://"), false);
});

test("requireRedisUrl fails fast in multi mode without a valid URL", () => {
  assert.throws(() => requireRedisUrl(loadEnv({ BENTO_MODE: "multi" })), /REDIS_URL is required/);
  assert.throws(
    () => requireRedisUrl(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "" })),
    /REDIS_URL is required/,
  );
  assert.throws(
    () => requireRedisUrl(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "   " })),
    /REDIS_URL is required/,
  );
  assert.throws(
    () => requireRedisUrl(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "not-a-url" })),
    /redis:\/\/ or rediss:\/\//,
  );
  assert.throws(
    () => requireRedisUrl(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "http://127.0.0.1:6379" })),
    /redis:\/\/ or rediss:\/\//,
  );
  assert.equal(
    requireRedisUrl(loadEnv({ BENTO_MODE: "multi", REDIS_URL: `  ${validRedis}  ` })),
    validRedis,
  );
  assert.equal(
    requireRedisUrl(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "rediss://cache.example:6380" })),
    "rediss://cache.example:6380",
  );
});

test("requireRedisUrl is not how local mode reads REDIS_URL", () => {
  assert.throws(
    () => requireRedisUrl(loadEnv({ BENTO_MODE: "local", REDIS_URL: leftoverRedis })),
    /REDIS_URL is required in multi mode/,
  );
});

test("local construction uses PgBossQueue and ignores REDIS_URL", async () => {
  const env = loadEnv({ BENTO_MODE: "local", REDIS_URL: leftoverRedis });
  const jobs = await createRuntimeJobQueue(env, {} as PgBoss);
  assert.ok(jobs instanceof PgBossQueue);
});

test("startServer in multi mode fails fast without a valid REDIS_URL", async () => {
  const { startServer } = await import("../server.js");
  await assert.rejects(
    () =>
      startServer({
        quiet: true,
        env: {
          BENTO_MODE: "multi",
          DATABASE_URL: "postgres://invalid.example:5432/app",
          BENTO_SECRET_KEY: "a".repeat(64),
          // Empty overrides a leftover process REDIS_URL and then reads as absent.
          REDIS_URL: "",
        },
      }),
    /REDIS_URL is required/,
  );
  await assert.rejects(
    () =>
      startServer({
        quiet: true,
        env: {
          BENTO_MODE: "multi",
          DATABASE_URL: "postgres://invalid.example:5432/app",
          BENTO_SECRET_KEY: "a".repeat(64),
          REDIS_URL: "http://127.0.0.1:6379",
        },
      }),
    /redis:\/\/ or rediss:\/\//,
  );
});

test("multi construction refuses before loading Redis when the URL is missing", async () => {
  await assert.rejects(
    () => createRuntimeJobQueue(loadEnv({ BENTO_MODE: "multi" }), null),
    /REDIS_URL is required/,
  );
  await assert.rejects(
    () => createRuntimeJobQueue(loadEnv({ BENTO_MODE: "multi", REDIS_URL: "http://localhost" }), null),
    /redis:\/\/ or rediss:\/\//,
  );
});

/**
 * A leftover REDIS_URL on a laptop must not pull ioredis into the
 * process. BullMQ lives in bullmq.ts and is imported only from the
 * multi-mode path in runtime.ts.
 */
test("local startup does not import Redis", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const allowed = new Set([
    "jobs/bullmq.ts",
    "jobs/bullmq.test.ts",
    "jobs/contract.test.ts",
    "jobs/import-pgboss.test.ts",
    "jobs/test-queue.ts",
  ]);
  const forbidden =
    /from\s+["']bullmq["']|from\s+["']ioredis["']|import\s*\(\s*["']bullmq["']\s*\)|import\s*\(\s*["']ioredis["']\s*\)|require\s*\(\s*["']bullmq["']\s*\)|require\s*\(\s*["']ioredis["']\s*\)/;
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(path);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      const rel = path.slice(srcRoot.length + 1).replaceAll("\\", "/");
      if (allowed.has(rel)) continue;
      if (forbidden.test(readFileSync(path, "utf8"))) offenders.push(rel);
    }
  };
  visit(srcRoot);
  assert.deepEqual(offenders, [], `Redis import outside the BullMQ adapter in ${offenders.join(", ")}`);
});
