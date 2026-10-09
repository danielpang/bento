import assert from "node:assert/strict";
import test from "node:test";
import { Queue } from "bullmq";
import Redis from "ioredis";
import {
  BullMqQueue,
  bullMqJobId,
  bullMqPrefix,
  bullMqRerunKey,
} from "./bullmq.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

let seq = 0;
function envName(): string {
  seq += 1;
  return `test-${process.pid}-${seq}`;
}

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

async function withJobs(
  fn: (jobs: BullMqQueue, redis: Redis, environment: string) => Promise<void>,
): Promise<void> {
  const environment = envName();
  const jobs = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  try {
    await fn(jobs, redis, environment);
  } finally {
    await jobs.stop().catch(() => {});
    await redis.quit().catch(() => {});
  }
}

test("restart-safe identifiers are deterministic and environment-prefixed", () => {
  assert.equal(bullMqPrefix("development"), "bento:development");
  assert.equal(bullMqPrefix("production"), "bento:production");
  assert.equal(bullMqJobId("dedupe", "swarm-1"), bullMqJobId("dedupe", "swarm-1"));
  assert.equal(bullMqJobId("coalesce", "s1"), "coalesce__s1");
  assert.equal(bullMqJobId("debounce", "sb1"), "debounce__sb1");
  assert.equal(bullMqJobId("dedupe", "a:b"), "dedupe__a%3Ab");
  assert.equal(
    bullMqRerunKey("bento:development", "swarm.tick", "s1"),
    "bento:development:rerun:swarm.tick:s1",
  );
  assert.notEqual(bullMqPrefix("development"), bullMqPrefix("production"));
});

test("a producer can send before any worker, and work then drains it", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    await jobs.send("previews", { id: "p1" });
    assert.deepEqual(await jobs.counts("previews"), { waiting: 1, active: 0, delayed: 0 });
    const seen: unknown[] = [];
    await jobs.work("previews", { concurrency: 1 }, async (data) => {
      seen.push(data);
    });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [{ id: "p1" }]);
    assert.deepEqual(await jobs.counts("previews"), { waiting: 0, active: 0, delayed: 0 });
  });
});

test("delayMs holds the job until the delay elapses", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const seen: number[] = [];
    await jobs.work("sandbox.hibernate", { concurrency: 1 }, async () => {
      seen.push(Date.now());
    });
    const start = Date.now();
    await jobs.send("sandbox.hibernate", { sandboxId: "sb" }, { delayMs: 300 });
    await waitFor(() => seen.length === 1);
    assert.ok(seen[0]! - start >= 250);
  });
});

test("dedupeKey keeps one job until it finishes, then the key is free", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const seen: string[] = [];
    const started = deferred();
    const release = deferred();
    await jobs.work("swarm.publish", { concurrency: 1 }, async (data: { n: string }) => {
      seen.push(data.n);
      if (seen.length === 1) {
        started.resolve();
        await release.promise;
      }
    });
    await jobs.send("swarm.publish", { n: "a" }, { dedupeKey: "s1" });
    await jobs.send("swarm.publish", { n: "b" }, { dedupeKey: "s1" });
    await started.promise;
    assert.deepEqual(seen, ["a"]);
    release.resolve();
    await waitFor(async () => (await jobs.counts("swarm.publish")).waiting === 0 && seen.length === 1);
    await jobs.send("swarm.publish", { n: "c" }, { dedupeKey: "s1" });
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ["a", "c"]);
  });
});

test("coalesceKey keeps one waiting job and records exactly one Redis rerun while active", { timeout: 15_000 }, async () => {
  await withJobs(async (jobs, redis, environment) => {
    const seen: Array<{ n: number }> = [];
    const started = deferred();
    const release = deferred();
    await jobs.work("swarm.tick", { concurrency: 1 }, async (data: { n: number }) => {
      seen.push(data);
      if (seen.length === 1) {
        started.resolve();
        await release.promise;
      }
    });
    await jobs.send("swarm.tick", { n: 1 }, { coalesceKey: "s1" });
    await jobs.send("swarm.tick", { n: 1 }, { coalesceKey: "s1" });
    await started.promise;
    assert.equal(seen.length, 1);
    await jobs.send("swarm.tick", { n: 2 }, { coalesceKey: "s1" });
    await jobs.send("swarm.tick", { n: 3 }, { coalesceKey: "s1" });
    const flag = bullMqRerunKey(bullMqPrefix(environment), "swarm.tick", "s1");
    assert.equal(await redis.get(flag), "1");
    release.resolve();
    await waitFor(() => seen.length === 2);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.n, 3);
    assert.equal(await redis.get(flag), null);
  });
});

test("debounceKey replaces a waiting delayed job and pushes its delay back", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const seen: number[] = [];
    await jobs.work("sandbox.hibernate", { concurrency: 1 }, async (data: { n: number }) => {
      seen.push(data.n);
    });
    await jobs.send("sandbox.hibernate", { n: 1 }, { debounceKey: "sb1", delayMs: 400 });
    await new Promise((r) => setTimeout(r, 120));
    await jobs.send("sandbox.hibernate", { n: 2 }, { debounceKey: "sb1", delayMs: 400 });
    await new Promise((r) => setTimeout(r, 220));
    assert.deepEqual(seen, []);
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [2]);
  });
});

test("attempts and backoff retry a failing handler", { timeout: 15_000 }, async () => {
  await withJobs(async (jobs) => {
    let attempts = 0;
    await jobs.work("slack.notify", { concurrency: 1 }, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("retry me");
    });
    await jobs.send("slack.notify", { type: "created" }, { attempts: 3, backoffMs: 40 });
    await waitFor(() => attempts === 3);
    assert.equal(attempts, 3);
  });
});

test("schedule upserts a Job Scheduler and unschedule removes it", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs, redis, environment) => {
    const prefix = bullMqPrefix(environment);
    await jobs.schedule("watchdog:s1", "swarm.watchdog", "*/5 * * * *", { swarmId: "s1" });
    const inspect = new Queue("swarm.watchdog", { connection: redis, prefix });
    try {
      const first = await inspect.getJobSchedulers();
      assert.equal(first.length, 1);
      assert.equal(first[0]?.key, "watchdog:s1");
      await jobs.schedule("watchdog:s1", "swarm.watchdog", "*/10 * * * *", { swarmId: "s1" });
      const upserted = await inspect.getJobSchedulers();
      assert.equal(upserted.length, 1);
      assert.equal(upserted[0]?.pattern, "*/10 * * * *");
      await jobs.unschedule("watchdog:s1");
      assert.equal((await inspect.getJobSchedulers()).length, 0);
    } finally {
      await inspect.close();
    }
  });
});

test("counts report waiting, active, and delayed", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const started = deferred();
    const release = deferred();
    await jobs.work("linear.inbound", { concurrency: 1 }, async () => {
      started.resolve();
      await release.promise;
    });
    await jobs.send("linear.inbound", { a: 1 });
    await started.promise;
    await jobs.send("linear.inbound", { b: 2 });
    await jobs.send("linear.inbound", { c: 3 }, { delayMs: 60_000 });
    const counts = await jobs.counts("linear.inbound");
    assert.equal(counts.active, 1);
    assert.equal(counts.waiting, 1);
    assert.equal(counts.delayed, 1);
    release.resolve();
  });
});

test("work concurrency runs that many jobs at once", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    let active = 0;
    let max = 0;
    const held: Array<() => void> = [];
    await jobs.work("linear.create-issue", { concurrency: 2 }, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => {
        held.push(() => {
          active -= 1;
          resolve();
        });
      });
    });
    await jobs.send("linear.create-issue", { issueId: "a" });
    await jobs.send("linear.create-issue", { issueId: "b" });
    await waitFor(() => held.length === 2);
    assert.equal(max, 2);
    for (const release of held) release();
  });
});

test("stop waits for the active job and then accepts no more work", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const started = deferred();
    let finished = false;
    await jobs.work("gate.evaluate", { concurrency: 1 }, async () => {
      started.resolve();
      await new Promise((r) => setTimeout(r, 150));
      finished = true;
    });
    await jobs.send("gate.evaluate", { featureId: "f1" });
    await started.promise;
    await jobs.stop();
    assert.equal(finished, true);
    await assert.rejects(() => jobs.send("gate.evaluate", { featureId: "f2" }));
  });
});

test("a new adapter with the same prefix reuses the Redis job id", { timeout: 10_000 }, async () => {
  const environment = envName();
  const first = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  try {
    await first.send("swarm.publish", { swarmId: "s1" }, { dedupeKey: "s1" });
    assert.equal((await first.counts("swarm.publish")).waiting, 1);
  } finally {
    await first.stop();
  }
  const second = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  try {
    await second.send("swarm.publish", { swarmId: "s1" }, { dedupeKey: "s1" });
    assert.deepEqual(await second.counts("swarm.publish"), { waiting: 1, active: 0, delayed: 0 });
  } finally {
    await second.stop();
  }
});

test("environment prefixes isolate two queues on one Redis", { timeout: 10_000 }, async () => {
  const a = new BullMqQueue({ redisUrl: REDIS_URL, environment: envName() });
  const b = new BullMqQueue({ redisUrl: REDIS_URL, environment: envName() });
  try {
    await a.send("linear.sweep", { org: "a" });
    assert.equal((await a.counts("linear.sweep")).waiting, 1);
    assert.equal((await b.counts("linear.sweep")).waiting, 0);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test("wake and offWork are no-ops and do not stop a worker", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const seen: string[] = [];
    await jobs.work("linear.outbound", { concurrency: 1 }, async (data: { id: string }) => {
      seen.push(data.id);
    });
    jobs.wake("linear.outbound");
    await jobs.offWork("linear.outbound");
    await jobs.send("linear.outbound", { id: "kept" });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, ["kept"]);
  });
});
