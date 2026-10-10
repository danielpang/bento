/**
 * Cutover copy of payload-only pg-boss jobs into BullMQ.
 *
 * These three queues carry information no domain row holds. Repeat
 * imports must not duplicate them, and a crash mid-copy must still
 * leave every pending payload on the next boot. The pgboss schema
 * stays in place.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Queue } from "bullmq";
import Redis from "ioredis";
import PgBoss from "pg-boss";
import pg from "pg";
import { BullMqQueue, bullMqPrefix } from "./bullmq.js";
import { FakeJobQueue } from "./fake.js";
import {
  PAYLOAD_ONLY_QUEUES,
  importedPgbossJobId,
  importPgbossPayloadJobs,
} from "./import-pgboss.js";
import { testRedisUrl } from "./test-queue.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "pgboss_payload_import_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);
const REDIS_URL = testRedisUrl();

let seq = 0;
function envName(): string {
  seq += 1;
  return `import-${process.pid}-${seq}`;
}

function waitFor(pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await pred()) {
        resolve();
        return;
      }
      if (Date.now() - start > ms) {
        reject(new Error("timed out"));
        return;
      }
      setTimeout(() => {
        void tick();
      }, 25);
    };
    void tick();
  });
}

async function resetPgboss(): Promise<void> {
  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  } finally {
    await client.end();
  }
}

async function withBoss(
  fn: (boss: PgBoss) => Promise<void>,
): Promise<void> {
  await resetPgboss();
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  try {
    for (const name of [...PAYLOAD_ONLY_QUEUES, "run.execute"] as const) {
      await boss.createQueue(name);
    }
    await fn(boss);
  } finally {
    await boss.stop({ close: true, timeout: 2000 }).catch(() => {});
  }
}

async function withJobs(
  fn: (jobs: BullMqQueue, environment: string) => Promise<void>,
): Promise<void> {
  const environment = envName();
  const jobs = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  try {
    await fn(jobs, environment);
  } finally {
    await jobs.stop().catch(() => {});
  }
}

async function pgbossJobCount(name: string, state: string): Promise<number> {
  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pgboss.job WHERE name = $1 AND state::text = $2`,
      [name, state],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

async function schemaExists(): Promise<boolean> {
  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss') AS exists`,
    );
    return Boolean(rows[0]?.exists);
  } finally {
    await client.end();
  }
}

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

describe("import pgboss payload jobs", { concurrency: 1 }, () => {
test("imported job ids are a deterministic function of the pg-boss id", () => {
  assert.equal(importedPgbossJobId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), importedPgbossJobId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
  assert.equal(importedPgbossJobId("id:1"), "import__id%3A1");
  assert.deepEqual([...PAYLOAD_ONLY_QUEUES], ["slack.notify", "linear.outbound", "linear.create-issue"]);
});

test("startServer copies payload-only jobs on the first BullMQ boot", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "server.ts"), "utf8");
  assert.match(src, /importPgbossPayloadJobs/);
  assert.match(src, /jobs\.kind === "bullmq"/);
});

test("a pg-boss queue is a no-op and a missing schema is not an error", async () => {
  const pool = new pg.Pool({ connectionString: testUrl });
  try {
    const fake = new FakeJobQueue("pg-boss");
    assert.deepEqual(await importPgbossPayloadJobs({ pool, jobs: fake }), { imported: 0, skipped: 0 });
    await withJobs(async (jobs) => {
      assert.deepEqual(await importPgbossPayloadJobs({ pool, jobs, schema: "pgboss_absent" }), {
        imported: 0,
        skipped: 0,
      });
    });
  } finally {
    await pool.end();
  }
});

test("created and retry payload jobs copy once; completed and other queues do not", { timeout: 20_000 }, async () => {
  const slackCreated = { type: "created" as const, featureId: "feat-created" };
  const slackRetry = { type: "run_finished" as const, featureId: "feat-retry", runId: "run-1" };
  const outbound = { featureId: "feat-out", toStatus: "in_progress", toStageId: null };
  const createIssue = { featureId: "feat-create" };
  const completed = { type: "created" as const, featureId: "feat-done" };
  const runJob = { runId: "run-skip" };

  let slackCreatedId = "";
  let slackRetryId = "";
  let outboundId = "";
  let createIssueId = "";

  await withBoss(async (boss) => {
    slackCreatedId = (await boss.send("slack.notify", slackCreated)) as string;
    slackRetryId = (await boss.send("slack.notify", slackRetry)) as string;
    outboundId = (await boss.send("linear.outbound", outbound)) as string;
    createIssueId = (await boss.send("linear.create-issue", createIssue)) as string;
    const completedId = (await boss.send("slack.notify", completed)) as string;
    await boss.send("run.execute", runJob);
    const client = new pg.Client({ connectionString: testUrl });
    await client.connect();
    try {
      await client.query(`UPDATE pgboss.job SET state = 'retry' WHERE id = $1`, [slackRetryId]);
      await client.query(`UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE id = $1`, [completedId]);
    } finally {
      await client.end();
    }
  });

  const pool = new pg.Pool({ connectionString: testUrl });
  try {
    await withJobs(async (jobs, environment) => {
      const first = await importPgbossPayloadJobs({ pool, jobs });
      assert.equal(first.imported, 4);
      assert.equal(first.skipped, 0);
      assert.deepEqual(await jobs.counts("slack.notify"), { waiting: 2, active: 0, delayed: 0 });
      assert.deepEqual(await jobs.counts("linear.outbound"), { waiting: 1, active: 0, delayed: 0 });
      assert.deepEqual(await jobs.counts("linear.create-issue"), { waiting: 1, active: 0, delayed: 0 });
      assert.deepEqual(await jobs.counts("run.execute"), { waiting: 0, active: 0, delayed: 0 });

      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      const prefix = bullMqPrefix(environment);
      const inspect = new Queue("slack.notify", { connection: redis, prefix });
      const outboundQ = new Queue("linear.outbound", { connection: redis, prefix });
      const createQ = new Queue("linear.create-issue", { connection: redis, prefix });
      try {
        const copied = await inspect.getJob(importedPgbossJobId(slackCreatedId));
        assert.ok(copied);
        assert.deepEqual(copied.data, slackCreated);
        assert.equal(copied.opts.attempts, 9);
        assert.deepEqual(copied.opts.backoff, { type: "exponential", delay: 15_000 });
        assert.equal(copied.opts.removeOnComplete, false);
        assert.ok(await inspect.getJob(importedPgbossJobId(slackRetryId)));
        assert.deepEqual((await outboundQ.getJob(importedPgbossJobId(outboundId)))?.data, outbound);
        assert.deepEqual((await createQ.getJob(importedPgbossJobId(createIssueId)))?.data, createIssue);
      } finally {
        await inspect.close();
        await outboundQ.close();
        await createQ.close();
        await redis.quit();
      }

      const again = await importPgbossPayloadJobs({ pool, jobs });
      assert.equal(again.imported, 0);
      assert.equal(again.skipped, 4);
      assert.deepEqual(await jobs.counts("slack.notify"), { waiting: 2, active: 0, delayed: 0 });
      assert.deepEqual(await jobs.counts("linear.outbound"), { waiting: 1, active: 0, delayed: 0 });
      assert.deepEqual(await jobs.counts("linear.create-issue"), { waiting: 1, active: 0, delayed: 0 });
    });
  } finally {
    await pool.end();
  }

  assert.equal(await pgbossJobCount("slack.notify", "created"), 1);
  assert.equal(await pgbossJobCount("slack.notify", "retry"), 1);
  assert.equal(await pgbossJobCount("slack.notify", "completed"), 1);
  assert.equal(await pgbossJobCount("linear.outbound", "created"), 1);
  assert.equal(await pgbossJobCount("linear.create-issue", "created"), 1);
  assert.equal(await pgbossJobCount("run.execute", "created"), 1);
  assert.equal(await schemaExists(), true);
});

test("a crash mid-import then a restart keeps every pending payload once", { timeout: 20_000 }, async () => {
  const payloads = [
    { type: "created" as const, featureId: "a" },
    { type: "created" as const, featureId: "b" },
    { type: "created" as const, featureId: "c" },
    { type: "created" as const, featureId: "d" },
    { type: "created" as const, featureId: "e" },
  ];
  await withBoss(async (boss) => {
    for (const data of payloads) await boss.send("slack.notify", data);
  });

  const pool = new pg.Pool({ connectionString: testUrl });
  const environment = envName();
  const inner = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  let attempts = 0;
  const failing = {
    kind: "bullmq" as const,
    importOnce: async (
      queue: Parameters<BullMqQueue["importOnce"]>[0],
      data: unknown,
      opts: Parameters<BullMqQueue["importOnce"]>[2],
    ) => {
      attempts += 1;
      if (attempts === 3) throw new Error("import interrupted");
      return inner.importOnce(queue, data, opts);
    },
  };

  try {
    await assert.rejects(
      () => importPgbossPayloadJobs({ pool, jobs: failing as unknown as BullMqQueue }),
      /import interrupted/,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(await inner.counts("slack.notify"), { waiting: 2, active: 0, delayed: 0 });

    const recovered = await importPgbossPayloadJobs({ pool, jobs: inner });
    assert.equal(recovered.imported, 3);
    assert.equal(recovered.skipped, 2);
    assert.deepEqual(await inner.counts("slack.notify"), { waiting: 5, active: 0, delayed: 0 });

    const seen: string[] = [];
    await inner.work<{ featureId: string }>("slack.notify", { concurrency: 1 }, async (data) => {
      seen.push(data.featureId);
    });
    await waitFor(() => seen.length === 5);
    assert.deepEqual(seen.sort(), ["a", "b", "c", "d", "e"]);

    const afterWork = await importPgbossPayloadJobs({ pool, jobs: inner });
    assert.equal(afterWork.imported, 0);
    assert.equal(afterWork.skipped, 5);
    await waitFor(async () => (await inner.counts("slack.notify")).waiting === 0);
    assert.deepEqual(seen.sort(), ["a", "b", "c", "d", "e"]);
  } finally {
    await inner.stop().catch(() => {});
    await pool.end();
  }

  assert.equal(await schemaExists(), true);
  assert.equal(await pgbossJobCount("slack.notify", "created"), 5);
});
});
