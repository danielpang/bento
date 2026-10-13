import type pg from "pg";

/**
 * Rows moved per committed transaction.
 *
 * pg-boss archive is one statement: delete every job past the archive
 * window and insert those rows into the archive table, with no limit.
 * The pool's query_timeout is 30s. The script pg-boss sends also sets
 * lock_timeout to 30s inside that same client timer, which starts when
 * the script is submitted. A lock wait or a large backlog therefore
 * fails the whole script with "Query read timeout". node-pg rejects
 * the query and leaves it in flight, pool.query then destroys the
 * connection, and the move rolls back. The next supervise tries the
 * same backlog. A batch this size finishes inside the timer, and each
 * batch commits, so a later failure keeps what already moved.
 */
export const ARCHIVE_BATCH_SIZE = 100;

/**
 * Batches one supervise pass will run. Whatever is left waits for the
 * next maintenance interval (two minutes, by pg-boss's default), so a
 * large backlog cannot hold a boss-pool connection for the whole table.
 */
export const ARCHIVE_MAX_BATCHES = 50;

/**
 * Server-side cancel for one batch. It stays under the pool
 * query_timeout (30s) so Postgres aborts the statement and the
 * connection can roll back, instead of node-pg giving up on the socket
 * with "Query read timeout".
 */
export const ARCHIVE_STATEMENT_TIMEOUT_MS = 20_000;

/**
 * How long one batch waits for the maintenance advisory lock.
 * pg-boss waits 30s inside the same client timer as the move. This
 * wait is its own query, and it is short enough that the client timer
 * still belongs to the batch.
 */
export const ARCHIVE_LOCK_TIMEOUT_MS = 2_000;

export type PgBossArchivePlan = {
  schema: string;
  where: string;
  columns: string;
};

const SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMNS = /^[a-z_]+(?:\s*,\s*[a-z_]+)*$/;

const ARCHIVE_REFUSAL =
  "pg-boss archive script was not rewritten. Refusing to run it as one statement.";

/**
 * The archive script from pg-boss 10 (`plans.archive` wrapped in
 * `plans.locked`). Anything else, including the sibling drop and
 * expire scripts, is left alone. A script that looks like archive but
 * does not match is refused: forwarding it would run the unbounded
 * move this module exists to replace.
 */
export function parsePgBossArchive(sql: string): PgBossArchivePlan | null {
  if (!sql.includes("WITH archived_rows AS")) return null;
  const deleted = sql.match(
    /DELETE FROM ([A-Za-z_][A-Za-z0-9_]*)\.job\s+WHERE\s+([\s\S]*?)\s+RETURNING \*/,
  );
  if (!deleted) return null;
  const schema = deleted[1];
  if (!schema || !SCHEMA.test(schema)) return null;
  const where = deleted[2]?.trim();
  if (!where || where.includes(";") || where.includes("$")) return null;
  const inserted = sql.match(new RegExp(`INSERT INTO ${schema}\\.archive \\(([^)]+)\\)`));
  const columns = inserted?.[1]?.trim();
  if (!columns || !COLUMNS.test(columns)) return null;
  if (!sql.includes(`INSERT INTO ${schema}.archive`)) return null;
  return { schema, where, columns };
}

export function looksLikePgBossArchive(sql: string): boolean {
  if (sql.includes("WITH archived_rows AS")) return true;
  return (
    /DELETE\s+FROM\s+[A-Za-z_][A-Za-z0-9_]*\.job\b/.test(sql) &&
    /INSERT\s+INTO\s+[A-Za-z_][A-Za-z0-9_]*\.archive\b/.test(sql)
  );
}

/**
 * The plan for an archive script, or null when the SQL is something
 * else pg-boss runs. Throws when the SQL is archive-shaped and cannot
 * be batched, including a script that carries parameters.
 */
export function matchPgBossArchive(sql: string, values?: unknown[]): PgBossArchivePlan | null {
  if (!looksLikePgBossArchive(sql)) return null;
  if (values !== undefined && values.length > 0) throw new Error(ARCHIVE_REFUSAL);
  const plan = parsePgBossArchive(sql);
  if (!plan) throw new Error(ARCHIVE_REFUSAL);
  return plan;
}

/** Same advisory-lock key pg-boss takes around archive, expire, and drop. */
export function pgBossMaintenanceLockSql(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error(`refusing to lock schema ${schema}`);
  return `SELECT pg_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.${schema}')::bytea), 'hex'))::bit(64)::bigint
    )`;
}

export function isQueryReadTimeout(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("Query read timeout");
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

/** Postgres `canceling statement due to statement timeout` (57014). */
export function isStatementTimeout(err: unknown): err is Error {
  return err instanceof Error && errorCode(err) === "57014" && /statement timeout/i.test(err.message);
}

/** Postgres `canceling statement due to lock timeout` (55P03). */
export function isLockTimeout(err: unknown): err is Error {
  return err instanceof Error && errorCode(err) === "55P03";
}

function batchSql(plan: PgBossArchivePlan): string {
  // candidates is one pass over the predicate, capped at the batch.
  // doomed then locks those rows and skips any another session holds.
  // seen versus moved is how a short batch tells "drained" from "the
  // rest are locked", without a second scan of job.
  return `
    WITH candidates AS MATERIALIZED (
      SELECT name, id
      FROM ${plan.schema}.job
      WHERE ${plan.where}
      LIMIT $1
    ),
    doomed AS (
      SELECT j.name, j.id
      FROM ${plan.schema}.job j
      JOIN candidates c ON c.name = j.name AND c.id = j.id
      FOR UPDATE OF j SKIP LOCKED
    ),
    archived_rows AS (
      DELETE FROM ${plan.schema}.job j
      USING doomed d
      WHERE j.name = d.name AND j.id = d.id
      RETURNING j.*
    ),
    inserted AS (
      INSERT INTO ${plan.schema}.archive (${plan.columns})
      SELECT ${plan.columns}
      FROM archived_rows
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT
      (SELECT count(*)::int FROM candidates) AS seen,
      (SELECT count(*)::int FROM archived_rows) AS moved,
      -- Referenced so the insert runs. moved counts deletes, which
      -- still advance the backlog when a row was already archived.
      (SELECT count(*)::int FROM inserted) AS inserted
  `;
}

type BatchClient = Pick<pg.PoolClient, "query" | "release">;

async function rollbackQuietly(client: Pick<pg.PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The transaction is already closed, or the socket is gone.
  }
}

type BatchOutcome = { seen: number; moved: number };

async function runBatch(
  client: Pick<pg.PoolClient, "query">,
  plan: PgBossArchivePlan,
  batchSize: number,
): Promise<BatchOutcome> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL lock_timeout = '${ARCHIVE_LOCK_TIMEOUT_MS}ms'`);
  await client.query(`SET LOCAL statement_timeout = ${ARCHIVE_STATEMENT_TIMEOUT_MS}`);
  await client.query(pgBossMaintenanceLockSql(plan.schema));
  const result = await client.query<{ seen: number; moved: number }>(batchSql(plan), [batchSize]);
  await client.query("COMMIT");
  const row = result.rows[0];
  return { seen: Number(row?.seen ?? 0), moved: Number(row?.moved ?? 0) };
}

/**
 * Run one pg-boss archive script as a series of committed batches.
 *
 * A "Query read timeout" means the socket was given up on while the
 * statement was still in flight. ROLLBACK cannot be sent until that
 * statement ends, so the client is destroyed immediately and the batch
 * is retried once on a new connection. Postgres ends the open
 * transaction when the socket closes. A second timeout, or any other
 * error, is thrown for pg-boss to report.
 *
 * A statement timeout (the batch exceeded its server-side budget) rolls
 * back that attempt and retries a smaller batch, down to one row. A
 * maintenance lock that is still held after the short lock timeout is
 * thrown. So is a batch that saw eligible rows it could not lock.
 * pg-boss then reports the pass instead of treating it as a finished
 * archive.
 */
export async function archivePgBossJobs(
  pool: pg.Pool,
  plan: PgBossArchivePlan,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<pg.QueryResult> {
  let batchSize = options?.batchSize ?? ARCHIVE_BATCH_SIZE;
  const maxBatches = options?.maxBatches ?? ARCHIVE_MAX_BATCHES;
  let client: BatchClient = await pool.connect();
  let released = false;
  const release = (err?: Error) => {
    if (released) return;
    released = true;
    client.release(err);
  };
  let moved = 0;
  try {
    let batches = 0;
    while (batches < maxBatches) {
      let outcome: BatchOutcome;
      try {
        outcome = await runBatch(client, plan, batchSize);
      } catch (err) {
        if (isQueryReadTimeout(err)) {
          // Destroy the socket before any other query. A ROLLBACK would
          // sit behind the statement that is still in flight and wait
          // out another query_timeout.
          release(err);
          client = await pool.connect();
          released = false;
          try {
            outcome = await runBatch(client, plan, batchSize);
          } catch (retryErr) {
            if (isQueryReadTimeout(retryErr)) release(retryErr);
            else if (!released) await rollbackQuietly(client);
            throw retryErr;
          }
        } else if (isStatementTimeout(err)) {
          await rollbackQuietly(client);
          if (batchSize <= 1) throw err;
          batchSize = Math.max(1, Math.floor(batchSize / 2));
          continue;
        } else if (isLockTimeout(err)) {
          await rollbackQuietly(client);
          throw new Error(
            "pg-boss archive could not take the maintenance lock. Eligible jobs stay until the next pass.",
            { cause: err },
          );
        } else {
          await rollbackQuietly(client);
          throw err;
        }
      }
      moved += outcome.moved;
      batches += 1;
      if (outcome.moved < outcome.seen && (outcome.seen < batchSize || outcome.moved === 0)) {
        // The rows this batch could lock are already committed. The
        // ones it skipped stay until the next pass, and the pass is
        // not reported as a finished archive.
        throw new Error("pg-boss archive left eligible jobs locked. They stay until the next pass.");
      }
      if (outcome.seen < batchSize) break;
    }
  } catch (err) {
    if (isQueryReadTimeout(err)) release(err);
    else if (!released) await rollbackQuietly(client);
    throw err;
  } finally {
    release();
  }
  return { command: "INSERT", rowCount: moved, rows: [], oid: 0, fields: [] };
}
