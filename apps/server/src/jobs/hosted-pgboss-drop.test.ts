/**
 * Hosted-only pgboss drop: the operational SQL is not in the shared
 * migration chain, boot no longer queries the schema, and every
 * named queue has an import or a rebuild.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import pg from "pg";
import { PgBossQueue } from "./pg-boss.js";
import {
  PAYLOAD_ONLY_QUEUES,
  PGBOSS_DROP_COVERAGE,
  queuesWithDropFate,
} from "./import-pgboss.js";
import { QUEUE_NAMES } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const migrationsDir = join(repoRoot, "packages/db/migrations");
const opsDir = join(repoRoot, "packages/db/ops");
const runbook = join(repoRoot, "docs/multi-queue-production.md");
const dropSqlPath = join(opsDir, "hosted-drop-pgboss.sql");
const inventorySqlPath = join(opsDir, "hosted-inventory-pgboss.sql");

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "hosted_pgboss_drop_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("every named queue has a drop fate, and payload-only matches import", () => {
  assert.deepEqual(Object.keys(PGBOSS_DROP_COVERAGE).sort(), [...QUEUE_NAMES].sort());
  assert.deepEqual(queuesWithDropFate("import").sort(), [...PAYLOAD_ONLY_QUEUES].sort());
  for (const name of PAYLOAD_ONLY_QUEUES) {
    assert.equal(PGBOSS_DROP_COVERAGE[name], "import");
  }
});

test("the hosted drop is an ops file, not a shared migration", () => {
  const journal = JSON.parse(read(join(migrationsDir, "meta/_journal.json"))) as {
    entries: Array<{ tag: string }>;
  };
  const tags = journal.entries.map((entry) => entry.tag);
  assert.ok(!tags.some((tag) => tag.includes("pgboss") || tag.includes("hosted-drop")));

  const sqlFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  for (const name of sqlFiles) {
    const src = read(join(migrationsDir, name));
    assert.doesNotMatch(src, /drop\s+schema\s+(if\s+exists\s+)?pgboss/i, `${name} drops pgboss`);
    assert.doesNotMatch(src, /pgboss/i, `${name} mentions pgboss`);
  }

  const dropSql = read(dropSqlPath);
  assert.match(dropSql, /Hosted \/ multi databases only/);
  assert.match(dropSql, /Irreversible without restore/);
  assert.match(dropSql, /DROP SCHEMA IF EXISTS pgboss CASCADE/);
  assert.match(dropSql, /packages\/db\/migrations/);
  assert.match(dropSql, /hosted-inventory-pgboss\.sql/);

  const inventorySql = read(inventorySqlPath);
  assert.match(inventorySql, /Hosted \/ multi databases only/);
  for (const name of PAYLOAD_ONLY_QUEUES) {
    assert.match(inventorySql, new RegExp(name.replace(".", "\\.")));
  }
  assert.match(inventorySql, /information_schema\.schemata/);
  assert.doesNotMatch(inventorySql, /DROP\s+SCHEMA/i);
});

test("the runbook records inventory, backup, sign-off, and the hosted drop", () => {
  const src = read(runbook);
  for (const needle of [
    "hosted-inventory-pgboss.sql",
    "hosted-drop-pgboss.sql",
    "import-pgboss-cli.ts",
    "backup",
    "sign-off",
    "irreversible without restore",
    "Do not place this drop in the shared migration chain",
    "Do not remove `PgBossQueue`",
    "development first",
  ]) {
    assert.match(src, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `runbook is missing ${needle}`);
  }
});

test("the owner one-shot refuses to run without hosted URLs", async () => {
  const { runHostedPgbossImport } = await import("./import-pgboss-cli.js");
  await assert.rejects(() => runHostedPgbossImport({}), /DATABASE_URL/);
  await assert.rejects(
    () => runHostedPgbossImport({ DATABASE_URL: "postgres://localhost/app" }),
    /REDIS_URL/,
  );
  await assert.rejects(
    () => runHostedPgbossImport({ DATABASE_URL: "postgres://localhost/app", REDIS_URL: "http://x" }),
    /redis:\/\/ or rediss:\/\//,
  );
});

test("hosted boot no longer queries pgboss, and PgBossQueue stays exported", () => {
  const server = read(join(here, "../server.ts"));
  assert.doesNotMatch(server, /importPgbossPayloadJobs/);
  assert.doesNotMatch(server, /from\s+["'].*import-pgboss/);
  assert.doesNotMatch(server, /pgboss\.job/);
  assert.match(server, /jobQueueBackend\(env\) === "pg-boss"/);
  assert.match(server, /schema: "pgboss"/);

  const index = read(join(here, "index.ts"));
  assert.match(index, /export \{ PgBossQueue \}/);

  const srcRoot = join(here, "..");
  const allowed = new Set([
    "jobs/import-pgboss.ts",
    "jobs/import-pgboss-cli.ts",
    "jobs/import-pgboss.test.ts",
    "jobs/hosted-pgboss-drop.test.ts",
    "jobs/pg-boss.test.ts",
    "jobs/test-queue.ts",
  ]);
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(path);
        continue;
      }
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts") || ent.name.endsWith(".e2e.test.ts")) {
        continue;
      }
      const rel = path.slice(srcRoot.length + 1).replaceAll("\\", "/");
      if (allowed.has(rel)) continue;
      const src = read(path);
      if (/pgboss\.job|FROM\s+pgboss\b/i.test(src)) offenders.push(rel);
    }
  };
  visit(srcRoot);
  assert.deepEqual(offenders, [], `hosted production still queries pgboss in ${offenders.join(", ")}`);
});

describe("hosted drop SQL", { concurrency: 1 }, () => {
before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
});

after(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`).catch(() => {});
  await admin.end();
});

test("the hosted drop removes pgboss and local pg-boss can recreate it", { timeout: 20_000 }, async () => {
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue("slack.notify");
  await boss.send("slack.notify", { type: "created", featureId: "keep-local" });
  await boss.stop({ close: true, timeout: 2000 }).catch(() => {});

  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    const before = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') AS exists`,
    );
    assert.equal(before.rows[0]?.exists, true);
    await client.query(read(dropSqlPath));
    const after = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') AS exists`,
    );
    assert.equal(after.rows[0]?.exists, false);
    // A second apply is a no-op: the file uses IF EXISTS.
    await client.query(read(dropSqlPath));
  } finally {
    await client.end();
  }

  const again = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  again.on("error", () => {});
  await again.start();
  try {
    const jobs = new PgBossQueue(again);
    assert.equal(jobs.kind, "pg-boss");
    await jobs.send("slack.notify", { type: "created", featureId: "after-drop" });
    assert.deepEqual(await jobs.counts("slack.notify"), { waiting: 1, active: 0, delayed: 0 });
  } finally {
    await again.stop({ close: true, timeout: 2000 }).catch(() => {});
  }
});
});
