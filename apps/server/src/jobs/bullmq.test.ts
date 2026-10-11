import assert from "node:assert/strict";
import test from "node:test";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { enqueueGateEvaluate } from "../orchestrator/queue.js";
import {
  BullMqQueue,
  bullMqJobId,
  bullMqPrefix,
  bullMqPresenceKey,
  bullMqRerunKey,
  bullMqRerunPayloadKey,
  isDuplicateJobIdError,
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

test("isDuplicateJobIdError accepts only a stable-job-id collision", () => {
  const id = bullMqJobId("dedupe", "s1");
  assert.equal(isDuplicateJobIdError(new Error(`Job ${id} already exists`), id), true);
  assert.equal(isDuplicateJobIdError(new Error(`Job ${id} already exists!`), id), true);
  assert.equal(isDuplicateJobIdError(new Error("READONLY You can't write against a read only replica."), id), false);
  assert.equal(isDuplicateJobIdError(new Error("Job other already exists"), id), false);
  assert.equal(isDuplicateJobIdError(new Error("connection already exists"), id), false);
  assert.equal(isDuplicateJobIdError({ message: `Job ${id} already exists` }, id), false);
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

test("gate.evaluate coalesceKey records exactly one Redis rerun while active", { timeout: 15_000 }, async () => {
  await withJobs(async (jobs, redis, environment) => {
    const seen: string[] = [];
    const started = deferred();
    const release = deferred();
    await jobs.work("gate.evaluate", { concurrency: 1 }, async (data: { featureId: string }) => {
      seen.push(data.featureId);
      if (seen.length === 1) {
        started.resolve();
        await release.promise;
      }
    });
    await enqueueGateEvaluate({ jobs }, "feat-1");
    await enqueueGateEvaluate({ jobs }, "feat-1");
    await started.promise;
    assert.deepEqual(seen, ["feat-1"]);
    await enqueueGateEvaluate({ jobs }, "feat-1");
    await enqueueGateEvaluate({ jobs }, "feat-1");
    const flag = bullMqRerunKey(bullMqPrefix(environment), "gate.evaluate", "feat-1");
    assert.equal(await redis.get(flag), "1");
    release.resolve();
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ["feat-1", "feat-1"]);
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

test("presence is a prefixed Redis key", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs, redis, environment) => {
    await jobs.setPresence("parked-compute", 4);
    assert.equal(await jobs.getPresence("parked-compute"), 4);
    assert.equal(await redis.get(bullMqPresenceKey(bullMqPrefix(environment), "parked-compute")), "4");
    await jobs.setPresence("parked-compute", 0);
    assert.equal(await jobs.getPresence("parked-compute"), 0);
    assert.equal(await redis.get(bullMqPresenceKey(bullMqPrefix(environment), "parked-compute")), null);
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

test("batchSize without concurrency is how many jobs run at once", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    let active = 0;
    let max = 0;
    const held: Array<() => void> = [];
    await jobs.work("gate.evaluate", { batchSize: 5, pollingIntervalSeconds: 30 }, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => {
        held.push(() => {
          active -= 1;
          resolve();
        });
      });
    });
    await Promise.all([
      jobs.send("gate.evaluate", { featureId: "a" }),
      jobs.send("gate.evaluate", { featureId: "b" }),
      jobs.send("gate.evaluate", { featureId: "c" }),
      jobs.send("gate.evaluate", { featureId: "d" }),
      jobs.send("gate.evaluate", { featureId: "e" }),
    ]);
    await waitFor(() => held.length === 5);
    assert.equal(max, 5);
    for (const release of held) release();
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

test("a high-concurrency worker is still one Worker, not one per slot", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    assert.equal(jobs.kind, "bullmq");
    let active = 0;
    let max = 0;
    const held: Array<() => void> = [];
    await jobs.work("previews", { concurrency: 4, batchSize: 1, pollingIntervalSeconds: 30 }, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => {
        held.push(() => {
          active -= 1;
          resolve();
        });
      });
    });
    await Promise.all([
      jobs.send("previews", { runId: "a" }),
      jobs.send("previews", { runId: "b" }),
      jobs.send("previews", { runId: "c" }),
      jobs.send("previews", { runId: "d" }),
    ]);
    await waitFor(() => held.length === 4);
    assert.equal(max, 4);
    for (const release of held) release();
  });
});

test("Promise.all concurrent first keyed sends succeed and a late consumer drains once", { timeout: 15_000 }, async () => {
  await withJobs(async (jobs) => {
    const cases = [
      { queue: "swarm.publish" as const, opts: { dedupeKey: "race-1" }, payload: { n: 1 } },
      { queue: "swarm.tick" as const, opts: { coalesceKey: "race-1" }, payload: { n: 1 } },
      { queue: "sandbox.hibernate" as const, opts: { debounceKey: "race-1", delayMs: 200 }, payload: { n: 1 } },
    ];
    for (const { queue, opts, payload } of cases) {
      await Promise.all([jobs.send(queue, payload, opts), jobs.send(queue, payload, opts)]);
      const seen: unknown[] = [];
      await jobs.work(queue, { concurrency: 1 }, async (data) => {
        seen.push(data);
      });
      await waitFor(() => seen.length === 1);
      assert.deepEqual(seen, [payload]);
      await waitFor(async () => {
        const counts = await jobs.counts(queue);
        return counts.waiting === 0 && counts.active === 0 && counts.delayed === 0;
      });
    }
  });
});

test("a stable-job-id duplicate add is success; unrelated q.add errors propagate", { timeout: 10_000 }, async () => {
  await withJobs(async (jobs) => {
    const jobId = bullMqJobId("dedupe", "s1");
    jobs.testAddKeyed = async () => {
      throw new Error(`Job ${jobId} already exists`);
    };
    await jobs.send("swarm.publish", { n: 1 }, { dedupeKey: "s1" });
    jobs.testAddKeyed = async () => {
      throw new Error("READONLY You can't write against a read only replica.");
    };
    await assert.rejects(
      () => jobs.send("swarm.publish", { n: 2 }, { dedupeKey: "s2" }),
      /READONLY/,
    );
    jobs.testAddKeyed = async () => {
      throw new Error("Connection is closed.");
    };
    await assert.rejects(
      () => jobs.send("swarm.tick", { n: 3 }, { coalesceKey: "s3" }),
      /Connection is closed/,
    );
    await assert.rejects(
      () => jobs.send("sandbox.hibernate", { n: 4 }, { debounceKey: "s4", delayMs: 100 }),
      /Connection is closed/,
    );
    jobs.testAddKeyed = undefined;
  });
});

test("a forced rerun add failure restores the flag and payload", { timeout: 15_000 }, async () => {
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
    await started.promise;
    await jobs.send("swarm.tick", { n: 3 }, { coalesceKey: "s1" });
    const flag = bullMqRerunKey(bullMqPrefix(environment), "swarm.tick", "s1");
    const payload = bullMqRerunPayloadKey(bullMqPrefix(environment), "swarm.tick", "s1");
    assert.equal(await redis.get(flag), "1");
    let addFailed = false;
    jobs.testAddKeyed = async (jobId) => {
      if (jobId === bullMqJobId("coalesce", "s1")) {
        addFailed = true;
        throw new Error("forced add failure");
      }
    };
    release.resolve();
    await waitFor(() => addFailed);
    await waitFor(async () => (await redis.get(flag)) === "1" && (await redis.get(payload)) !== null);
    assert.equal(await redis.get(flag), "1");
    assert.deepEqual(JSON.parse((await redis.get(payload))!), { n: 3 });
    assert.deepEqual(seen, [{ n: 1 }]);
    jobs.testAddKeyed = undefined;
    await jobs.send("swarm.tick", { n: 4 }, { coalesceKey: "s1" });
    await waitFor(() => seen.some((row) => row.n === 3));
    assert.ok(seen.some((row) => row.n === 4));
    assert.equal(await redis.get(flag), null);
  });
});

test("stop waits for in-flight rerun work so the replacement job is added", { timeout: 15_000 }, async () => {
  const environment = envName();
  const jobs = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  const started = deferred();
  const release = deferred();
  const addStarted = deferred();
  const holdAdd = deferred();
  let addFinished = false;
  await jobs.work("swarm.tick", { concurrency: 1 }, async (data: { n: number }) => {
    if (data.n === 1) {
      started.resolve();
      await release.promise;
    }
  });
  await jobs.send("swarm.tick", { n: 1 }, { coalesceKey: "s1" });
  await started.promise;
  await jobs.send("swarm.tick", { n: 3 }, { coalesceKey: "s1" });
  jobs.testAddKeyed = async (jobId, add) => {
    if (jobId === bullMqJobId("coalesce", "s1")) {
      addStarted.resolve();
      await holdAdd.promise;
      addFinished = true;
    }
    await add();
  };
  try {
    release.resolve();
    await addStarted.promise;
    const stopping = jobs.stop();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(addFinished, false);
    holdAdd.resolve();
    await stopping;
    assert.equal(addFinished, true);
  } catch (err) {
    holdAdd.resolve();
    await jobs.stop().catch(() => {});
    throw err;
  }
  const again = new BullMqQueue({ redisUrl: REDIS_URL, environment });
  try {
    const seen: number[] = [];
    await again.work("swarm.tick", { concurrency: 1 }, async (data: { n: number }) => {
      seen.push(data.n);
    });
    await waitFor(() => seen.length === 1);
    assert.deepEqual(seen, [3]);
  } finally {
    await again.stop();
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
