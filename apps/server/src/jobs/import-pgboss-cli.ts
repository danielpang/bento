/**
 * One-shot copy of leftover payload-only pg-boss jobs into BullMQ.
 *
 * Hosted boot no longer does this. Run it from an owner shell against
 * a hosted database if inventory still shows created/retry rows on
 * slack.notify, linear.outbound, or linear.create-issue. Local and
 * Mac never need it.
 *
 *   DATABASE_URL=... REDIS_URL=... BENTO_ENVIRONMENT=production \
 *     pnpm --filter @bento/server exec tsx src/jobs/import-pgboss-cli.ts
 */
import { createPool } from "@bento/db";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BullMqQueue } from "./bullmq.js";
import { importPgbossPayloadJobs } from "./import-pgboss.js";
import { isValidRedisUrl } from "./runtime.js";

export async function runHostedPgbossImport(env: NodeJS.ProcessEnv = process.env): Promise<{
  imported: number;
  skipped: number;
}> {
  const databaseUrl = env.DATABASE_URL?.trim();
  const redisUrl = env.REDIS_URL?.trim();
  const environment = env.BENTO_ENVIRONMENT?.trim() || "production";
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  if (!redisUrl) throw new Error("REDIS_URL is required.");
  if (!isValidRedisUrl(redisUrl)) throw new Error("REDIS_URL must be a redis:// or rediss:// URL.");

  const pool = createPool(databaseUrl);
  const jobs = new BullMqQueue({ redisUrl, environment });
  try {
    return await importPgbossPayloadJobs({ pool, jobs });
  } finally {
    await jobs.stop().catch(() => {});
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runHostedPgbossImport()
    .then((result) => {
      console.log(`imported ${result.imported}, skipped ${result.skipped}`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
