import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { ensureEmbeddedPostgres } from "./embedded-postgres.js";

async function query(url: string, sql: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Mac app runs local Bento with nothing installed. Its database has
 * to keep what was written across a restart and across a crash that
 * left Postgres running with nobody to stop it.
 */
test("embedded Postgres keeps its data across a clean stop and an orphaned server", { timeout: 180_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bento-embedded-pg-"));
  try {
    const first = await ensureEmbeddedPostgres(dataDir);
    assert.equal(first.initialised, true);
    assert.match(first.databaseUrl, /^postgres:\/\/postgres:[0-9a-f]+@127\.0\.0\.1:\d+\/app$/);
    await query(first.databaseUrl, "create table kept (v text); insert into kept values ('yes')");
    const version = await query(first.databaseUrl, "show server_version");
    assert.match(version.rows[0].server_version, /^17\./);
    const listen = await query(first.databaseUrl, "show listen_addresses");
    assert.equal(listen.rows[0].listen_addresses, "127.0.0.1");
    await first.stop();
    await first.stop();
    await assert.rejects(fs.access(path.join(dataDir, "postgres", "postmaster.pid")));

    const second = await ensureEmbeddedPostgres(dataDir);
    assert.equal(second.initialised, false);
    assert.deepEqual((await query(second.databaseUrl, "select v from kept")).rows, [{ v: "yes" }]);
    // Leave this one running, as a parent killed with SIGKILL would.
    const orphanPid = Number((await fs.readFile(path.join(dataDir, "postgres", "postmaster.pid"), "utf8")).split("\n")[0]);

    const third = await ensureEmbeddedPostgres(dataDir);
    try {
      assert.equal(alive(orphanPid), false, "the orphaned Postgres is stopped before a new one starts");
      assert.deepEqual((await query(third.databaseUrl, "select v from kept")).rows, [{ v: "yes" }]);
    } finally {
      await third.stop();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("a postmaster.pid naming a live process that is not Postgres does not block a start", { timeout: 120_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bento-embedded-pg-"));
  try {
    const first = await ensureEmbeddedPostgres(dataDir);
    await first.stop();
    // This test process stands in for whatever reused the dead postmaster's pid.
    await fs.writeFile(path.join(dataDir, "postgres", "postmaster.pid"), `${process.pid}\n${path.join(dataDir, "postgres")}\n`);
    const second = await ensureEmbeddedPostgres(dataDir);
    try {
      assert.equal((await query(second.databaseUrl, "select 1 as one")).rows[0].one, 1);
    } finally {
      await second.stop();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
