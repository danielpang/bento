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

/**
 * How long an unused client may sit in the pool before we close it.
 *
 * node-pg defaults to 10 seconds. Cloud Postgres (Neon PgBouncer, a
 * Fly proxy, an idle NAT) can drop the TCP session without a RST, and
 * the next checkout then hangs until the OS read times out
 * (`read ETIMEDOUT`). Closing first, below those idle kills, means
 * the pool never hands out a socket the peer has already forgotten.
 */
export const POOL_IDLE_TIMEOUT_MS = 4_000;

/**
 * How long to wait when opening or checking out a client. 0 (node-pg's
 * default) waits until the OS gives up, which is how a stale Neon
 * connect became a minute-plus Timekeeper error.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Recycle a client before a long-lived proxy or Neon compute suspend
 * (five minutes idle) can silently invalidate it. Connections that
 * stay busy never hit the idle timer, so this is the backstop.
 */
export const POOL_MAX_LIFETIME_SECONDS = 240;

/**
 * Start TCP keepalive probes after this much socket idle. Linux
 * otherwise waits two hours, which is well after the next pg-boss
 * cron tick has already blocked on a dead read.
 */
export const POOL_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * Node error codes for a pooled socket the peer has already dropped.
 *
 * Neon's PgBouncer, a Fly proxy, or an idle NAT can close a TCP session
 * without a RST. The next read from that socket surfaces `ETIMEDOUT`
 * (the `read ETIMEDOUT` pg-boss cron sees) or `ECONNRESET`.
 */
const TRANSIENT_CONNECTION_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNRESET"]);

/**
 * Whether this error is a dropped-socket failure the pool recovers from
 * on its own.
 *
 * pg-pool discards the dead client and the next checkout opens a fresh
 * one, so the caller (a pg-boss cron tick, an HTTP query) retries and
 * nothing downstream breaks. Each drop still arrives as a distinct
 * error with its own message and stack, so error tracking fingerprints
 * every one separately unless the reporter groups them; this predicate
 * is how a reporter tells the recoverable drops apart from real faults.
 */
export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CONNECTION_ERROR_CODES.has(code);
}

/**
 * Pool options shared by the app pool and pg-boss. pg-boss builds its
 * own `pg.Pool` from the constructor config (`new pg.Pool(config)`),
 * so Timekeeper cron and the HTTP pool have to be configured the same
 * way or only one of them learns to drop a dead socket.
 */
export function postgresPoolConfig(
  databaseUrl: string,
  options?: { max?: number },
): pg.PoolConfig {
  return {
    connectionString: databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: POOL_KEEPALIVE_INITIAL_DELAY_MS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    maxLifetimeSeconds: POOL_MAX_LIFETIME_SECONDS,
    ...(options?.max !== undefined ? { max: options.max } : {}),
  };
}

export function createPool(databaseUrl: string, options?: { max?: number }): pg.Pool {
  const pool = new pg.Pool(postgresPoolConfig(databaseUrl, options));
  // A dead idle client is discarded by pg-pool; the next checkout
  // opens a replacement. A listener is required so that event is not
  // an unhandled error on the pool.
  pool.on("error", () => {});
  return pool;
}

/**
 * The `executeSql` surface pg-boss 10 needs when we own the pool.
 * Passing this (instead of a connection string) is how Timekeeper
 * cron gets the same keepalive and idle recycle as the app pool.
 * pg-boss will not close a pool it did not create; call `pool.end()`.
 */
export function pgBossDatabase(pool: pg.Pool): {
  executeSql(text: string, values?: unknown[]): Promise<pg.QueryResult>;
} {
  return {
    executeSql(text, values) {
      return pool.query(text, values);
    },
  };
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/** Throws if the database is unreachable. */
export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
