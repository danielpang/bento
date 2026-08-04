import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { createDb, createPool } from "./client.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * A fixed key for the migration advisory lock. Two machines booting at
 * once would otherwise race the same DDL.
 */
const MIGRATION_LOCK_KEY = 8_472_113_004;

/** One line of drizzle-kit's journal: a migration file and when it was generated. */
type JournalEntry = { idx: number; when: number; tag: string };

function readJournal(): JournalEntry[] {
  const file = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: JournalEntry[] };
  return journal.entries;
}

/**
 * The newest `created_at` in the migrator's own bookkeeping table.
 *
 * Drizzle records each applied migration's journal timestamp there and
 * applies exactly the entries newer than the latest one, so this single
 * value splits the journal into applied and pending. Null means a fresh
 * database: the table does not exist until the first migration run
 * creates it, which is a state to report, not an error.
 */
async function appliedWatermark(pool: pg.Pool): Promise<number | null> {
  try {
    const result = await pool.query<{ last: string | null }>(
      'select max(created_at) as last from drizzle."__drizzle_migrations"',
    );
    const last = result.rows[0]?.last;
    return last == null ? null : Number(last);
  } catch (err) {
    // 42P01: undefined_table. Anything else is a real failure and must
    // not read as "nothing applied yet".
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    const db = createDb(pool);
    // Serialize across machines: the second boot waits here, then finds
    // nothing left to apply.
    await pool.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      // Read after the lock is held, so a runner that waited behind
      // another reports what is true now, not what was true when it
      // started waiting.
      const entries = readJournal();
      const watermark = await appliedWatermark(pool);
      const applied = entries.filter((e) => watermark !== null && e.when <= watermark);
      const pending = entries.filter((e) => watermark === null || e.when > watermark);

      console.log(
        `${applied.length} of ${entries.length} migrations previously applied` +
          (applied.length > 0 ? `, through ${applied[applied.length - 1]!.tag}` : ""),
      );
      for (const entry of pending) {
        console.log(`  will apply ${entry.tag} (generated ${new Date(entry.when).toISOString()})`);
      }

      await migrate(db, { migrationsFolder });

      console.log(
        pending.length > 0 ? `applied ${pending.length} migration${pending.length === 1 ? "" : "s"}` : "nothing to apply",
      );
    } finally {
      await pool.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
  runMigrations(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
