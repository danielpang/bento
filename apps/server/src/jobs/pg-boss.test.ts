import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import PgBoss from "pg-boss";
import { enqueueGateEvaluate } from "../orchestrator/queue.js";
import { PgBossQueue } from "./pg-boss.js";

function stubBoss(existing?: { name: string; policy: string }) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const boss = {
    createQueue: async (...args: unknown[]) => {
      calls.push({ op: "createQueue", args });
    },
    updateQueue: async (...args: unknown[]) => {
      calls.push({ op: "updateQueue", args });
    },
    getQueue: async (name: string) => {
      calls.push({ op: "getQueue", args: [name] });
      return existing && existing.name === name ? existing : null;
    },
    send: async (...args: unknown[]) => {
      calls.push({ op: "send", args });
      return "job-1";
    },
    work: async (...args: unknown[]) => {
      calls.push({ op: "work", args: [args[0], args[1]] });
      return `w-${calls.length}`;
    },
    schedule: async (...args: unknown[]) => {
      calls.push({ op: "schedule", args });
    },
    unschedule: async (...args: unknown[]) => {
      calls.push({ op: "unschedule", args });
    },
    offWork: async (...args: unknown[]) => {
      calls.push({ op: "offWork", args });
    },
    notifyWorker: (...args: unknown[]) => {
      calls.push({ op: "notify", args });
    },
    stop: async (...args: unknown[]) => {
      calls.push({ op: "stop", args });
    },
    getQueueSize: async (_name: string, options?: { before?: string }) =>
      options?.before === "completed" ? 3 : 1,
    getJobById: async () => null,
    deleteJob: async (...args: unknown[]) => {
      calls.push({ op: "deleteJob", args });
    },
    cancel: async (...args: unknown[]) => {
      calls.push({ op: "cancel", args });
    },
  };
  return { boss: boss as unknown as PgBoss, calls };
}

test("coalesceKey is singletonKey on a short-policy queue", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  await jobs.send("swarm.tick", { swarmId: "s1" }, { coalesceKey: "s1" });
  assert.deepEqual(
    calls.find((c) => c.op === "createQueue"),
    { op: "createQueue", args: ["swarm.tick", { name: "swarm.tick", policy: "short" }] },
  );
  const send = calls.find((c) => c.op === "send");
  assert.equal(send?.args[0], "swarm.tick");
  assert.deepEqual(send?.args[1], { swarmId: "s1" });
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "s1");
});

test("gate.evaluate coalesceKey is singletonKey on a short-policy queue", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  await jobs.send("gate.evaluate", { featureId: "f1" }, { coalesceKey: "f1" });
  assert.deepEqual(calls.find((c) => c.op === "createQueue"), {
    op: "createQueue",
    args: ["gate.evaluate", { name: "gate.evaluate", policy: "short" }],
  });
  const send = calls.find((c) => c.op === "send");
  assert.equal(send?.args[0], "gate.evaluate");
  assert.deepEqual(send?.args[1], { featureId: "f1" });
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "f1");
});

test("an existing standard gate.evaluate queue is upgraded to short", async () => {
  const { boss, calls } = stubBoss({ name: "gate.evaluate", policy: "standard" });
  const jobs = new PgBossQueue(boss);
  await jobs.send("gate.evaluate", { featureId: "f1" }, { coalesceKey: "f1" });
  assert.equal(calls.some((c) => c.op === "createQueue"), false);
  assert.deepEqual(calls.find((c) => c.op === "updateQueue"), {
    op: "updateQueue",
    args: ["gate.evaluate", { name: "gate.evaluate", policy: "short" }],
  });
  const send = calls.find((c) => c.op === "send");
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "f1");
});

test("an already-short coalesce queue is left alone", async () => {
  const { boss, calls } = stubBoss({ name: "gate.evaluate", policy: "short" });
  const jobs = new PgBossQueue(boss);
  await jobs.send("gate.evaluate", { featureId: "f1" }, { coalesceKey: "f1" });
  assert.equal(calls.some((c) => c.op === "createQueue"), false);
  assert.equal(calls.some((c) => c.op === "updateQueue"), false);
});

test("dedupeKey is singletonKey on a standard queue", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  await jobs.send("swarm.publish", { swarmId: "s1" }, { dedupeKey: "s1" });
  assert.deepEqual(calls[0], { op: "createQueue", args: ["swarm.publish"] });
  const send = calls.find((c) => c.op === "send");
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "s1");
  assert.equal(typeof (send?.args[2] as { id?: string }).id, "string");
});

test("debounceKey replaces via a stable job id", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  await jobs.send("sandbox.hibernate", { n: 1 }, { debounceKey: "sb1", delayMs: 500 });
  const send = calls.find((c) => c.op === "send");
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "sb1");
  assert.equal(typeof (send?.args[2] as { id?: string }).id, "string");
});

test("delayMs becomes startAfter and attempts map onto retryLimit", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  const before = Date.now();
  await jobs.send("sandbox.hibernate", { sandboxId: "sb" }, { delayMs: 5_000, attempts: 9, backoffMs: 15_000 });
  const opts = calls.find((c) => c.op === "send")?.args[2] as {
    startAfter: Date;
    retryLimit: number;
    retryDelay: number;
    retryBackoff: boolean;
  };
  assert.ok(opts.startAfter.getTime() >= before + 4_000);
  assert.equal(opts.retryLimit, 8);
  assert.equal(opts.retryDelay, 15);
  assert.equal(opts.retryBackoff, true);
});

test("kind is pg-boss", () => {
  const { boss } = stubBoss();
  assert.equal(new PgBossQueue(boss).kind, "pg-boss");
});

test("work concurrency registers that many workers, and wake notifies them", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  await jobs.work("run.execute", { concurrency: 3, batchSize: 1, pollingIntervalSeconds: 30 }, async () => {});
  assert.equal(calls.filter((c) => c.op === "work").length, 3);
  jobs.wake("run.execute");
  assert.equal(calls.filter((c) => c.op === "notify").length, 3);
});

test("counts read waiting and active from pg-boss queue size", async () => {
  const { boss } = stubBoss();
  const jobs = new PgBossQueue(boss);
  assert.deepEqual(await jobs.counts("run.execute"), { waiting: 1, active: 2, delayed: 0 });
});

const postgresUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

/**
 * createQueue does not change an already-created standard queue. A
 * local/Mac/self-hosted install still has gate.evaluate from before
 * COALESCE_QUEUES, so the adapter must upgrade that row and still
 * coalesce through enqueueGateEvaluate.
 */
test("existing standard gate.evaluate upgrades in place and coalesces one rerun", { timeout: 20_000 }, async () => {
  const schema = `pgboss_ge_${process.pid}_${Date.now()}`;
  const boss = new PgBoss({ connectionString: postgresUrl, schema });
  boss.on("error", () => {});
  await boss.start();
  const jobs = new PgBossQueue(boss);
  try {
    await boss.createQueue("gate.evaluate");
    const before = await boss.getQueue("gate.evaluate");
    assert.equal(before?.policy, "standard");
    await boss.send("gate.evaluate", { featureId: "legacy" });
    assert.equal(await boss.getQueueSize("gate.evaluate"), 1);

    await enqueueGateEvaluate({ jobs }, "feat-1");
    await enqueueGateEvaluate({ jobs }, "feat-1");
    const after = await boss.getQueue("gate.evaluate");
    assert.equal(after?.policy, "short");
    assert.equal(await boss.getQueueSize("gate.evaluate"), 2, "pending standard job must survive the upgrade");

    const seen: string[] = [];
    const started = deferred();
    const release = deferred();
    await jobs.work("gate.evaluate", { concurrency: 1, pollingIntervalSeconds: 1 }, async (data: { featureId: string }) => {
      seen.push(data.featureId);
      if (data.featureId === "feat-1" && seen.filter((id) => id === "feat-1").length === 1) {
        started.resolve();
        await release.promise;
      }
    });
    await started.promise;
    assert.equal(seen.filter((id) => id === "feat-1").length, 1);
    await enqueueGateEvaluate({ jobs }, "feat-1");
    await enqueueGateEvaluate({ jobs }, "feat-1");
    release.resolve();
    await waitFor(() => seen.filter((id) => id === "feat-1").length === 2);
    await waitFor(() => seen.includes("legacy"));
    assert.deepEqual(seen.filter((id) => id === "feat-1"), ["feat-1", "feat-1"]);
    assert.equal(seen.filter((id) => id === "legacy").length, 1);
  } finally {
    await jobs.stop().catch(() => {});
    const admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
