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
 * How long a single query may wait for its result before the client
 * is given up on and destroyed.
 *
 * Keepalive only guards a socket with nothing in flight. Once a query
 * has been written to a socket whose peer has vanished, the kernel
 * retransmits it with backoff and reports `read ETIMEDOUT` only after
 * tcp_retries2 gives up, about fifteen minutes on Linux. pg-boss's
 * Timekeeper holds its `timekeeping` flag for that whole wait and the
 * workers' fetches hang the same way, so a dead socket used to mean a
 * quarter hour of no cron and no jobs. node-pg's `query_timeout` fails
 * the query instead and, because the query is still active, tears the
 * socket down at once; the next checkout opens a fresh one. Every
 * query in this codebase is indexed and small next to this bound.
 */
export const POOL_QUERY_TIMEOUT_MS = 30_000;

/**
 * A wall clock gap with no checkout and no release, while an idle
 * client is still in the pool, after which the process is judged to
 * have been suspended.
 *
 * The idle timer closes an idle client within POOL_IDLE_TIMEOUT_MS of
 * its release, so while the process runs an idle client is never older
 * than that. A Fly machine suspend freezes the process with its
 * sockets; timers run on the monotonic clock, which stops with it, so
 * on resume they pick up where they left off while the wall clock
 * jumps forward by the hours the machine slept. An idle client whose
 * last activity is further back than this on the wall clock therefore
 * outlived a freeze, and the peer has long since dropped its end. The
 * threshold is well above any event loop stall and well below the five
 * minutes after which Neon suspends a compute, so a false positive
 * costs one reconnect and the outage this exists for cannot slip under
 * it.
 */
export const POOL_FROZEN_GAP_MS = 30_000;

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
    query_timeout: POOL_QUERY_TIMEOUT_MS,
    ...(options?.max !== undefined ? { max: options.max } : {}),
  };
}

type ConnectCallback = (
  err: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

/**
 * A pg.Pool that notices it was suspended and drops the sockets it
 * froze with.
 *
 * pg-pool trusts an idle client until its idle timer fires or the
 * socket reports an error. Neither happens across a machine suspend:
 * the socket is still established as far as this kernel knows, and on
 * resume the idle timers and the workers' next polls resume with
 * whatever was left on them, so a poll due before its client's idle
 * timer is handed a socket the peer closed hours ago. That query then
 * hangs until the kernel gives up on it. Retiring every idle client at
 * the first checkout after a wall clock gap means the wake-up query
 * opens a new connection instead.
 *
 * Idle clients are retired through the public surface: each is
 * checked out and released with an error, which pg-pool treats as
 * "do not reuse". The retire requests are queued ahead of the real
 * checkout, so the real one finds no idle client and connects fresh.
 *
 * Fly corrects the guest wall clock a few hundred milliseconds after
 * resume, so a poll that lands before the correction cannot be told
 * apart from a normal one and may still draw a dead socket. That is
 * what `query_timeout` is for: the query fails after a bounded wait
 * and the client goes with it.
 */
class RecyclingPool extends pg.Pool {
  private lastActivityAt = Date.now();

  constructor(config: pg.PoolConfig) {
    super(config);
    this.on("release", () => {
      this.lastActivityAt = Date.now();
    });
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    this.retireIdleClientsAfterFreeze();
    return callback ? super.connect(callback) : super.connect();
  }

  private retireIdleClientsAfterFreeze(): void {
    const now = Date.now();
    const frozen = now - this.lastActivityAt >= POOL_FROZEN_GAP_MS;
    this.lastActivityAt = now;
    if (!frozen) return;
    const stale = this.idleCount;
    for (let i = 0; i < stale; i++) {
      super.connect((err, client, release) => {
        if (err || !client) return;
        release(new Error("connection predates a process suspend and is presumed dead"));
      });
    }
  }
}

export function createPool(databaseUrl: string, options?: { max?: number }): pg.Pool {
  const pool = new RecyclingPool(postgresPoolConfig(databaseUrl, options));
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
