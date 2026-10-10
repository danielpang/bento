import assert from "node:assert/strict";
import test from "node:test";
import type PgBoss from "pg-boss";
import { PgBossQueue } from "./pg-boss.js";

function stubBoss() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const boss = {
    createQueue: async (...args: unknown[]) => {
      calls.push({ op: "createQueue", args });
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
  assert.deepEqual(calls[0], { op: "createQueue", args: ["swarm.tick", { name: "swarm.tick", policy: "short" }] });
  const send = calls.find((c) => c.op === "send");
  assert.equal(send?.args[0], "swarm.tick");
  assert.deepEqual(send?.args[1], { swarmId: "s1" });
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "s1");
});

test("gate.evaluate coalesceKey is singletonKey on a short-policy queue", async () => {
  const { boss, calls } = stubBoss();
  const jobs = new PgBossQueue(boss);
  await jobs.send("gate.evaluate", { featureId: "f1" }, { coalesceKey: "f1" });
  assert.deepEqual(calls[0], {
    op: "createQueue",
    args: ["gate.evaluate", { name: "gate.evaluate", policy: "short" }],
  });
  const send = calls.find((c) => c.op === "send");
  assert.equal(send?.args[0], "gate.evaluate");
  assert.deepEqual(send?.args[1], { featureId: "f1" });
  assert.equal((send?.args[2] as { singletonKey?: string }).singletonKey, "f1");
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
