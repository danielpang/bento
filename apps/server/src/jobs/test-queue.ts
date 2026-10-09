import PgBoss from "pg-boss";
import { PgBossQueue } from "./pg-boss.js";
import type { JobQueue } from "./types.js";

export const REAL_QUEUE_BACKENDS = ["pg-boss", "bullmq"] as const;
export type RealQueueBackend = (typeof REAL_QUEUE_BACKENDS)[number];

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

/**
 * Backends the real-queue suites run against. `JOB_QUEUE_BACKENDS` can
 * narrow that to one side while debugging; CI leaves it unset so both
 * adapters run.
 */
export function realQueueBackends(): readonly RealQueueBackend[] {
  const raw = process.env.JOB_QUEUE_BACKENDS?.trim();
  if (!raw) return REAL_QUEUE_BACKENDS;
  const picked = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is RealQueueBackend => part === "pg-boss" || part === "bullmq");
  return picked.length > 0 ? picked : REAL_QUEUE_BACKENDS;
}

export function testRedisUrl(): string {
  return process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
}

/**
 * A real JobQueue for contract and e2e suites. BullMQ is loaded only
 * when that backend is requested, the same way production keeps Redis
 * off the local/Mac path.
 */
export async function createTestJobQueue(opts: {
  backend: RealQueueBackend;
  postgresUrl: string;
  isolation: string;
}): Promise<JobQueue> {
  if (opts.backend === "bullmq") {
    const { BullMqQueue } = await import("./bullmq.js");
    return new BullMqQueue({
      redisUrl: testRedisUrl(),
      environment: opts.isolation,
    });
  }
  const schema = pgBossSchema(opts.isolation);
  const boss = new PgBoss({ connectionString: opts.postgresUrl, schema });
  boss.on("error", () => {});
  await boss.start();
  return new PgBossQueue(boss);
}

function pgBossSchema(isolation: string): string {
  const suffix = isolation.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 48);
  return suffix ? `pgboss_${suffix}` : "pgboss";
}
