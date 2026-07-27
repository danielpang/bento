import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb, createPool } from "./client.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * A fixed key for the migration advisory lock. Two machines booting at
 * once would otherwise race the same DDL.
 */
const MIGRATION_LOCK_KEY = 8_472_113_004;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    const db = createDb(pool);
    // Serialize across machines: the second boot waits here, then finds
    // nothing left to apply.
    await pool.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await pool.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
  runMigrations(url)
    .then(() => {
      console.log("migrations applied");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
