import type pg from "pg";
import { isQueryReadTimeout } from "./pg-boss-archive.js";

/**
 * A checkout that never got a client, so the statement never started.
 *
 * pg-pool says "timeout exceeded when trying to connect" when the pool
 * is already full and no client comes free within
 * connectionTimeoutMillis. That wait is for a slot. A new connection
 * that does not finish in time is "Connection terminated due to
 * connection timeout" from the pool, or "timeout expired" from
 * node-pg's own connect timer.
 */
export function isConnectTimeout(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message === "timeout exceeded when trying to connect" ||
      err.message === "Connection terminated due to connection timeout" ||
      err.message === "timeout expired")
  );
}

function isRetryablePollError(err: unknown): boolean {
  return isQueryReadTimeout(err) || isConnectTimeout(err);
}

/**
 * Client-side timeout for the statements pg-boss runs on a timer.
 *
 * A Fly machine resumes from a suspend with its wall clock still at
 * the moment it froze, for seconds rather than the instant the pool's
 * freeze check assumes, so a poll in that window can be handed a
 * socket the peer forgot while the machine slept. On the pool's 30s
 * bound that poll hangs half a minute: a worker picks up nothing and a
 * supervise or cron pass fails with "Query read timeout". These
 * statements are a few milliseconds on an indexed table, so a dead
 * socket is the only thing that keeps one waiting this long.
 */
export const PG_BOSS_POLL_TIMEOUT_MS = 10_000;

const FETCH = /^\s*WITH next as \(\s*SELECT id, singleton_key, policy\s+FROM [A-Za-z_][A-Za-z0-9_]*\.job\b/;
const TRY_SET_TIMESTAMP =
  /^\s*UPDATE [A-Za-z_][A-Za-z0-9_]*\.version SET (?:maintained_on|monitored_on|cron_on) = now\(\)\s+WHERE EXTRACT/;
const GET_TIME = "SELECT round(date_part('epoch', now()) * 1000) as time";

/**
 * True for the statements pg-boss runs on a timer and that can run a
 * second time without harm: a worker's fetch, the maintenance, monitor
 * and cron leases on the version row, and the clock skew read.
 *
 * Running one twice is safe. A lease the first attempt already took
 * comes back empty on the second, and that pass is skipped. A fetch
 * that reached the server marked its jobs active, where they wait for
 * their expiry exactly as they would without the retry, and the second
 * fetch takes other jobs. Anything else (sends, completions, the
 * locked maintenance scripts, migrations) keeps the pool's bound and
 * is never retried.
 */
export function isPgBossPoll(sql: string): boolean {
  return FETCH.test(sql) || TRY_SET_TIMESTAMP.test(sql) || sql.trim() === GET_TIME;
}

/**
 * Run a pg-boss poll with a short timeout, and once more when that
 * attempt could not finish.
 *
 * A "Query read timeout" is a socket the freeze check missed. pg-pool
 * destroys that client, and the pool retires its other idle clients
 * (they were idle across the same suspend), so the second attempt
 * connects fresh.
 *
 * A connect timeout is every slot already checked out for the whole
 * wait: connects that have not returned, or queries still in flight.
 * The statement never started. The first wait is the backoff. The
 * second attempt checks out again and takes a client once a slot
 * frees. A second failure of either kind is a real outage and goes to
 * pg-boss as before.
 */
export async function runPgBossPoll(
  pool: Pick<pg.Pool, "query">,
  text: string,
  values: unknown[] | undefined,
  timeoutMs: number = PG_BOSS_POLL_TIMEOUT_MS,
): Promise<pg.QueryResult> {
  // node-pg reads a per-query query_timeout; @types/pg does not declare it.
  const config: pg.QueryConfig & { query_timeout: number } = { text, query_timeout: timeoutMs };
  if (values !== undefined) config.values = values;
  try {
    return await pool.query(config);
  } catch (err) {
    if (!isRetryablePollError(err)) throw err;
    return pool.query(config);
  }
}
