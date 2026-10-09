import type PgBoss from "pg-boss";
import type { Env } from "../env.js";
import { PgBossQueue } from "./pg-boss.js";
import type { JobQueue } from "./types.js";

export type JobQueueBackend = "pg-boss" | "bullmq";

/**
 * Which JobQueue implementation this process constructs.
 *
 * An explicit runtime-mode decision, not "REDIS_URL exists": a laptop
 * or the Mac app with a leftover Redis URL still gets pg-boss, and
 * multi mode never falls back to pg-boss because Redis is missing.
 */
export function jobQueueBackend(env: Pick<Env, "BENTO_MODE">): JobQueueBackend {
  return env.BENTO_MODE === "multi" ? "bullmq" : "pg-boss";
}

/**
 * The Redis URL multi mode will use, or null when this process must
 * not talk to Redis. Null in local mode even if REDIS_URL is set.
 */
export function redisUrlForQueue(env: Env): string | null {
  if (jobQueueBackend(env) !== "bullmq") return null;
  const url = env.REDIS_URL?.trim();
  return url ? url : null;
}

export function isValidRedisUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "redis:" || parsed.protocol === "rediss:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Multi mode refuses to boot without a usable Redis URL. Call this
 * before constructing the queue so a missing or malformed value fails
 * before the process opens a database pool.
 */
export function requireRedisUrl(env: Env): string {
  const url = redisUrlForQueue(env);
  if (!url) {
    throw new Error("REDIS_URL is required in multi mode.");
  }
  if (!isValidRedisUrl(url)) {
    throw new Error("REDIS_URL must be a redis:// or rediss:// URL.");
  }
  return url;
}

/**
 * Construct the queue for this process. BullMQ is loaded only on the
 * multi-mode path, so a local or Mac startup never imports Redis.
 */
export async function createRuntimeJobQueue(env: Env, boss: PgBoss | null): Promise<JobQueue> {
  if (jobQueueBackend(env) === "pg-boss") {
    if (!boss) throw new Error("pg-boss is required when the queue backend is pg-boss");
    return new PgBossQueue(boss);
  }
  const redisUrl = requireRedisUrl(env);
  const { BullMqQueue } = await import("./bullmq.js");
  return new BullMqQueue({ redisUrl, environment: env.BENTO_ENVIRONMENT });
}
