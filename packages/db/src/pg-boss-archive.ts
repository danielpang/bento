import type pg from "pg";

/**
 * Rows moved per committed transaction.
 *
 * pg-boss archive is one statement: delete every job past the archive
 * window and insert those rows into the archive table, with no limit.
 * The pool's query_timeout is 30s, and the script pg-boss sends also
 * sets lock_timeout to 30s inside that same client timer, which starts
 * when the script is submitted. A lock wait or a large backlog therefore
 * fails the whole script with "Query read timeout", node-pg destroys
 * the connection, and the move rolls back. The next supervise tries the
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
 * connection can roll back, instead of node-pg destroying the socket
 * with "Query read timeout".
 */
export const ARCHIVE_STATEMENT_TIMEOUT_MS = 20_000;

export type PgBossArchivePlan = {
  schema: string;
  where: string;
  columns: string;
};

const SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMNS = /^[a-z_]+(?:\s*,\s*[a-z_]+)*$/;

/**
 * The archive script from pg-boss 10 (`plans.archive` wrapped in
 * `plans.locked`). Anything else, including the sibling drop and
 * expire scripts, is left alone.
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

/** Same advisory-lock key pg-boss takes around archive, expire, and drop. */
export function pgBossMaintenanceLockSql(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error(`refusing to lock schema ${schema}`);
  return `SELECT pg_try_advisory_xact_lock(
      ('x' || encode(sha224((current_database() || '.pgboss.${schema}')::bytea), 'hex'))::bit(64)::bigint
    ) AS locked`;
}

export function isQueryReadTimeout(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("Query read timeout");
}

function batchSql(plan: PgBossArchivePlan): string {
  return `
    WITH doomed AS (
      SELECT id
      FROM ${plan.schema}.job
      WHERE ${plan.where}
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    ),
    archived_rows AS (
      DELETE FROM ${plan.schema}.job
      WHERE id IN (SELECT id FROM doomed)
      RETURNING *
    ),
    inserted AS (
      INSERT INTO ${plan.schema}.archive (${plan.columns})
      SELECT ${plan.columns}
      FROM archived_rows
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT
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
    // A read timeout has already destroyed the socket.
  }
}

async function runBatch(
  client: Pick<pg.PoolClient, "query">,
  plan: PgBossArchivePlan,
  batchSize: number,
): Promise<number | "locked"> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL statement_timeout = ${ARCHIVE_STATEMENT_TIMEOUT_MS}`);
  const lock = await client.query<{ locked: boolean }>(pgBossMaintenanceLockSql(plan.schema));
  if (!lock.rows[0]?.locked) {
    await client.query("COMMIT");
    return "locked";
  }
  const result = await client.query<{ moved: number }>(batchSql(plan), [batchSize]);
  await client.query("COMMIT");
  return Number(result.rows[0]?.moved ?? 0);
}

/**
 * Run one pg-boss archive script as a series of committed batches.
 *
 * A "Query read timeout" means the socket was given up on (the
 * dead-peer backstop, or a batch that outran the client timer). The
 * client is dead either way, so that batch is retried once on a new
 * connection. A second timeout, or any other error, is thrown for
 * pg-boss to report.
 */
export async function archivePgBossJobs(
  pool: pg.Pool,
  plan: PgBossArchivePlan,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<pg.QueryResult> {
  const batchSize = options?.batchSize ?? ARCHIVE_BATCH_SIZE;
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
    for (let i = 0; i < maxBatches; i++) {
      let outcome: number | "locked";
      try {
        outcome = await runBatch(client, plan, batchSize);
      } catch (err) {
        await rollbackQuietly(client);
        if (!isQueryReadTimeout(err)) throw err;
        release(err);
        client = await pool.connect();
        released = false;
        try {
          outcome = await runBatch(client, plan, batchSize);
        } catch (retryErr) {
          await rollbackQuietly(client);
          if (isQueryReadTimeout(retryErr)) release(retryErr);
          throw retryErr;
        }
      }
      if (outcome === "locked") break;
      moved += outcome;
      if (outcome < batchSize) break;
    }
  } finally {
    release();
  }
  return { command: "INSERT", rowCount: moved, rows: [], oid: 0, fields: [] };
}
