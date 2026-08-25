import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

/**
 * App-pool size for a process that will drive this many agent runs.
 *
 * node-pg defaults to 10. Each run writes transcript rows and status,
 * and HTTP/gates share the same pool, so 10 is what used to stall the
 * board once more than a handful of agents were working. Headroom
 * covers those other callers. The floor is a backstop if the worker
 * count is ever set below the old default.
 */
export function poolMaxForRuns(concurrentRuns: number): number {
  return Math.max(10, concurrentRuns + 16);
}

export function createPool(databaseUrl: string, options?: { max?: number }): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    ...(options?.max !== undefined ? { max: options.max } : {}),
  });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/** Throws if the database is unreachable. */
export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
