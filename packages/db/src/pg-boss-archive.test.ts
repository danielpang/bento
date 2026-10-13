import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import pg from "pg";
import {
  ARCHIVE_LOCK_TIMEOUT_MS,
  ARCHIVE_STATEMENT_TIMEOUT_MS,
  archivePgBossJobs,
  isQueryReadTimeout,
  matchPgBossArchive,
  parsePgBossArchive,
  type PgBossArchivePlan,
} from "./pg-boss-archive.js";
import { POOL_QUERY_TIMEOUT_MS, createPool, pgBossDatabase } from "./client.js";

const require = createRequire(import.meta.url);
const plans = require("pg-boss/src/plans.js") as {
  archive: (schema: string, completedInterval: string, failedInterval?: string) => string;
  drop: (schema: string, interval: string) => string;
  locked: (schema: string, query: string) => string;
};

/** The script Boss.archive sends: plans.archive wrapped by plans.locked. */
function pgBossArchiveScript(schema: string): string {
  return plans.locked(schema, plans.archive(schema, "43200 seconds", "43200 seconds"));
}

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";

function statementTimeout(): Error {
  return Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
}

function lockTimeout(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
}

test("the archive timeouts stay inside the pool query timeout", () => {
  assert.ok(ARCHIVE_STATEMENT_TIMEOUT_MS < POOL_QUERY_TIMEOUT_MS);
  assert.ok(ARCHIVE_LOCK_TIMEOUT_MS < POOL_QUERY_TIMEOUT_MS);
  assert.equal(POOL_QUERY_TIMEOUT_MS, 30_000);
});

test("the installed pg-boss archive script is rewritten", () => {
  const script = pgBossArchiveScript("pgboss");
  const plan = parsePgBossArchive(script);
  assert.ok(plan);
  assert.equal(plan.schema, "pgboss");
  assert.match(plan.where, /completed_on < \(now\(\) - interval '43200 seconds'\)/);
  assert.match(plan.where, /state < 'active'/);
  assert.match(plan.columns, /^id, name,/);
  assert.match(plan.columns, /output$/);
  assert.deepEqual(matchPgBossArchive(script), plan);

  assert.equal(parsePgBossArchive("select 1"), null);
  assert.equal(matchPgBossArchive("select 1"), null);
  const drop = plans.locked("pgboss", plans.drop("pgboss", "7 days"));
  assert.equal(parsePgBossArchive(drop), null);
  assert.equal(matchPgBossArchive(drop), null);

  const drifted = script.replace("RETURNING *", "RETURNING id");
  assert.equal(parsePgBossArchive(drifted), null);
  assert.throws(() => matchPgBossArchive(drifted), /not rewritten/);
  assert.throws(() => matchPgBossArchive(script, [1]), /not rewritten/);
  assert.equal(
    parsePgBossArchive(script.replace("keep_until < now()", "keep_until < now(); drop table job")),
    null,
  );
});

type FakeResult = { rows: unknown[]; rowCount?: number };

function scriptedPool(
  onBatch: (values: unknown[] | undefined) => FakeResult | Error,
  options?: { locked?: boolean },
): {
  pool: pg.Pool;
  texts: string[];
  order: string[];
  released: Array<Error | undefined>;
  connects: () => number;
} {
  const texts: string[] = [];
  const order: string[] = [];
  const released: Array<Error | undefined> = [];
  let connects = 0;
  const connect = async () => {
    connects += 1;
    order.push("connect");
    const client = {
      query: async (text: string, values?: unknown[]) => {
        texts.push(text);
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SET LOCAL")) {
          if (text === "ROLLBACK") order.push("rollback");
          return { rows: [] };
        }
        if (text.includes("pg_advisory_xact_lock")) {
          if (options?.locked === false) throw lockTimeout();
          return { rows: [] };
        }
        if (text.includes("archived_rows")) {
          order.push("batch");
          const result = onBatch(values);
          if (result instanceof Error) throw result;
          return result;
        }
        throw new Error(`unexpected query: ${text}`);
      },
      release: (err?: Error) => {
        released.push(err);
        order.push(err ? "release-error" : "release");
      },
    };
    return client;
  };
  return {
    pool: { connect } as unknown as pg.Pool,
    texts,
    order,
    released,
    connects: () => connects,
  };
}

test("archive commits each batch and stops when a batch is short", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const moved = [2, 2, 1];
  let batches = 0;
  const { pool, texts } = scriptedPool((values) => {
    assert.deepEqual(values, [2]);
    const n = moved[batches] ?? 0;
    batches += 1;
    return { rows: [{ seen: n, moved: n, inserted: n }] };
  });

  const result = await archivePgBossJobs(pool, plan, { batchSize: 2 });
  assert.equal(result.rowCount, 5);
  assert.equal(batches, 3);
  assert.equal(texts.filter((text) => text.includes("archived_rows")).length, 3);
  assert.ok(texts.some((text) => text.includes("statement_timeout")));
  assert.ok(texts.some((text) => text.includes(`lock_timeout = '${ARCHIVE_LOCK_TIMEOUT_MS}ms'`)));
  assert.equal(
    texts.some((text) => text.includes("30s")),
    false,
  );
});

test("archive reports a maintenance lock it could not take", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const { pool, texts } = scriptedPool(
    () => {
      throw new Error("should not move rows without the lock");
    },
    { locked: false },
  );
  await assert.rejects(
    archivePgBossJobs(pool, plan, { batchSize: 2 }),
    /could not take the maintenance lock/,
  );
  assert.equal(
    texts.some((text) => text.includes("archived_rows")),
    false,
  );
});

test("a short batch reports eligible jobs another session still holds", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const { pool, texts } = scriptedPool(() => ({ rows: [{ seen: 1, moved: 0, inserted: 0 }] }));
  await assert.rejects(archivePgBossJobs(pool, plan, { batchSize: 2 }), /left eligible jobs locked/);
  assert.equal(texts.includes("COMMIT"), true);
});

test("a statement timeout retries a smaller batch", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const sizes: unknown[] = [];
  const { pool } = scriptedPool((values) => {
    sizes.push(values?.[0]);
    if (sizes.length === 1) return statementTimeout();
    return { rows: [{ seen: 1, moved: 1, inserted: 1 }] };
  });

  const result = await archivePgBossJobs(pool, plan, { batchSize: 8 });
  assert.equal(result.rowCount, 1);
  assert.deepEqual(sizes, [8, 4]);
});

test("a statement timeout on a single row is reported", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const { pool } = scriptedPool(() => statementTimeout());
  await assert.rejects(archivePgBossJobs(pool, plan, { batchSize: 1 }), /statement timeout/);
});

test("a query read timeout destroys the client before any rollback", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const timeout = new Error("Query read timeout");
  let batches = 0;
  const { pool, order, released, connects } = scriptedPool(() => {
    batches += 1;
    if (batches === 1) return timeout;
    return { rows: [{ seen: 1, moved: 1, inserted: 1 }] };
  });

  const result = await archivePgBossJobs(pool, plan, { batchSize: 10 });
  assert.equal(result.rowCount, 1);
  assert.equal(connects(), 2);
  assert.equal(batches, 2);
  assert.equal(released[0], timeout);
  assert.equal(released.at(-1), undefined);
  const failed = order.indexOf("release-error");
  const secondBatch = order.indexOf("batch", order.indexOf("batch") + 1);
  assert.ok(failed >= 0 && failed < secondBatch);
  assert.equal(order.includes("rollback"), false);
});

test("a second query read timeout is reported without a queued rollback", async () => {
  const plan = parsePgBossArchive(pgBossArchiveScript("pgboss"));
  assert.ok(plan);
  const timeout = new Error("Query read timeout");
  const { pool, order } = scriptedPool(() => timeout);
  await assert.rejects(archivePgBossJobs(pool, plan, { batchSize: 10 }), /Query read timeout/);
  assert.equal(isQueryReadTimeout(timeout), true);
  assert.equal(order.includes("rollback"), false);
  assert.equal(
    order.filter((event) => event === "release-error").length,
    2,
  );
});

test("queries that are not archive still use the pool directly", async () => {
  const seen: string[] = [];
  const pool = {
    query: async (text: string) => {
      seen.push(text);
      return { rows: [{ n: 1 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    },
    connect: async () => {
      throw new Error("archive path should not check out a client");
    },
  } as unknown as pg.Pool;
  const db = pgBossDatabase(pool);
  const result = await db.executeSql("select 1 as n");
  assert.equal(result.rows[0].n, 1);
  assert.deepEqual(seen, ["select 1 as n"]);
  const drop = await db.executeSql(plans.locked("pgboss", plans.drop("pgboss", "7 days")));
  assert.equal(drop.rows[0].n, 1);

  await assert.rejects(
    () => db.executeSql(pgBossArchiveScript("pgboss").replace("RETURNING *", "RETURNING id")),
    /not rewritten/,
  );
  assert.equal(seen.length, 2);
});

test("pg-boss archive moves eligible jobs in committed batches on postgres", async () => {
  const schema = `a${randomBytes(4).toString("hex")}`;
  const pool = createPool(databaseUrl, { max: 4 });
  const admin = new pg.Client({ connectionString: databaseUrl });
  try {
    await admin.connect();
  } catch (err) {
    await pool.end();
    throw new Error(`postgres is required for the archive test (${databaseUrl}): ${err}`);
  }
  try {
    await admin.query(`
      CREATE SCHEMA ${schema};
      CREATE TYPE ${schema}.job_state AS ENUM ('created', 'retry', 'active', 'completed', 'cancelled', 'failed');
      CREATE TABLE ${schema}.job (
        id uuid not null,
        name text not null,
        priority integer not null default 0,
        data jsonb,
        state ${schema}.job_state not null,
        retry_limit integer not null default 0,
        retry_count integer not null default 0,
        retry_delay integer not null default 0,
        retry_backoff boolean not null default false,
        start_after timestamptz not null default now(),
        started_on timestamptz,
        singleton_key text,
        singleton_on timestamp,
        expire_in interval not null default interval '15 minutes',
        created_on timestamptz not null default now(),
        completed_on timestamptz,
        keep_until timestamptz not null default now() + interval '14 days',
        output jsonb,
        dead_letter text,
        policy text,
        PRIMARY KEY (name, id)
      ) PARTITION BY LIST (name);
      CREATE TABLE ${schema}.job_run PARTITION OF ${schema}.job FOR VALUES IN ('run.execute');
      CREATE TABLE ${schema}.job_other PARTITION OF ${schema}.job FOR VALUES IN ('gate.evaluate');
      CREATE TABLE ${schema}.archive (LIKE ${schema}.job);
      ALTER TABLE ${schema}.archive ADD archived_on timestamptz NOT NULL DEFAULT now();
      ALTER TABLE ${schema}.archive ADD PRIMARY KEY (name, id);
    `);

    const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 1000);
    const rows: Array<[string, string, string, Date | null, Date]> = [
      ["11111111-1111-4111-8111-111111111111", "run.execute", "completed", old, past],
      ["22222222-2222-4222-8222-222222222222", "run.execute", "completed", old, past],
      ["33333333-3333-4333-8333-333333333333", "run.execute", "cancelled", old, past],
      ["44444444-4444-4444-8444-444444444444", "gate.evaluate", "failed", old, past],
      ["55555555-5555-4555-8555-555555555555", "run.execute", "created", null, past],
      ["66666666-6666-4666-8666-666666666666", "run.execute", "completed", recent, new Date(Date.now() + 86_400_000)],
      ["77777777-7777-4777-8777-777777777777", "run.execute", "active", null, new Date(Date.now() + 86_400_000)],
    ];
    for (const [id, name, state, completedOn, keepUntil] of rows) {
      await admin.query(
        `INSERT INTO ${schema}.job (id, name, state, completed_on, keep_until, data, output)
         VALUES ($1, $2, $3, $4, $5, '{"runId":"r"}', '{"value":"ok"}')`,
        [id, name, state, completedOn, keepUntil],
      );
    }

    const script = pgBossArchiveScript(schema);
    const plan = parsePgBossArchive(script);
    assert.ok(plan);

    // A failure on a later batch must leave the earlier batch committed.
    // The unbounded script rolls the whole move back, which is the bug.
    await admin.query(`
      CREATE FUNCTION ${schema}.stop_after_two() RETURNS trigger AS $$
      BEGIN
        IF (SELECT count(*) FROM ${schema}.archive) >= 2 THEN
          RAISE EXCEPTION 'stop after two';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER stop_after_two BEFORE INSERT ON ${schema}.archive
      FOR EACH ROW EXECUTE FUNCTION ${schema}.stop_after_two()
    `);

    await assert.rejects(
      archivePgBossJobs(pool, plan as PgBossArchivePlan, { batchSize: 2, maxBatches: 10 }),
      /stop after two/,
    );
    const partial = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.archive`);
    assert.equal(partial.rows[0].n, 2, "the batch that committed before the failure stayed archived");

    await admin.query(`DROP TRIGGER stop_after_two ON ${schema}.archive`);
    const finished = await pgBossDatabase(pool, { archiveBatchSize: 2 }).executeSql(script);
    assert.equal(finished.rowCount, 3, "the five eligible rows minus the two already archived");

    const left = await admin.query<{ state: string }>(`SELECT state::text AS state FROM ${schema}.job`);
    assert.deepEqual(
      left.rows.map((row) => row.state).sort(),
      ["active", "completed"],
    );
    const archived = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.archive`);
    assert.equal(archived.rows[0].n, 5);

    const again = await pgBossDatabase(pool).executeSql(script);
    assert.equal(again.rowCount, 0);
    const still = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.job`);
    assert.equal(still.rows[0].n, 2);

    const heldId = "88888888-8888-4888-8888-888888888888";
    await admin.query(
      `INSERT INTO ${schema}.job (id, name, state, completed_on, keep_until)
       VALUES ($1, 'run.execute', 'completed', $2, $3)`,
      [heldId, old, past],
    );
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM ${schema}.job WHERE id = $1 FOR UPDATE`, [heldId]);
      await assert.rejects(
        pgBossDatabase(pool, { archiveBatchSize: 2 }).executeSql(script),
        /left eligible jobs locked/,
      );
      const during = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.job WHERE id = $1`, [heldId]);
      assert.equal(during.rows[0].n, 1, "a row locked by another session stays in job");
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    const afterLock = await pgBossDatabase(pool, { archiveBatchSize: 2 }).executeSql(script);
    assert.equal(afterLock.rowCount, 1);

    const blockedId = "99999999-9999-4999-8999-999999999999";
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock(
          ('x' || encode(sha224((current_database() || '.pgboss.${schema}')::bytea), 'hex'))::bit(64)::bigint
        )`,
      );
      await admin.query(
        `INSERT INTO ${schema}.job (id, name, state, completed_on, keep_until)
         VALUES ($1, 'run.execute', 'completed', $2, $3)`,
        [blockedId, old, past],
      );
      const started = performance.now();
      await assert.rejects(
        pgBossDatabase(pool, { archiveBatchSize: 2 }).executeSql(script),
        /could not take the maintenance lock/,
      );
      assert.ok(performance.now() - started < 5_000, "a held maintenance lock does not wait out the 30s query timeout");
      const during = await admin.query(`SELECT count(*)::int AS n FROM ${schema}.job WHERE id = $1`, [blockedId]);
      assert.equal(during.rows[0].n, 1, "the eligible row stays put while the maintenance lock is held");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await pool.end();
  }
});
