/**
 * Shared JobQueue contract. Both adapters must pass the same cases:
 * send-before-work, delay, dedupe, active coalesce with one rerun,
 * debounce replacement, retry/backoff, schedule upsert/remove, counts,
 * concurrency, and graceful stop.
 *
 * Adapter-specific details (Redis rerun flags, environment prefixes,
 * pg-boss short policy) stay in bullmq.test.ts and pg-boss.test.ts.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { enqueueGateEvaluate } from "../orchestrator/queue.js";
import { createTestJobQueue, realQueueBackends, type RealQueueBackend } from "./test-queue.js";
import type { JobQueue, QueueName } from "./types.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "job_contract_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let seq = 0;

function isolation(backend: RealQueueBackend): string {
  seq += 1;
  return `${backend}-${process.pid}-${seq}`;
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

const workOpts = { concurrency: 1, pollingIntervalSeconds: 1 };

async function withJobs(
  backend: RealQueueBackend,
  fn: (jobs: JobQueue) => Promise<void>,
): Promise<void> {
  const jobs = await createTestJobQueue({
    backend,
    postgresUrl: testUrl,
    isolation: isolation(backend),
  });
  try {
    await fn(jobs);
  } finally {
    await jobs.stop().catch(() => {});
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

for (const backend of realQueueBackends()) {
  describe(backend, () => {
    test("a producer can send before any worker, and work then drains it", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        await jobs.send("previews", { id: "p1" });
        const queued = await jobs.counts("previews");
        assert.equal(queued.waiting + queued.delayed, 1);
        assert.equal(queued.active, 0);
        const seen: unknown[] = [];
        await jobs.work("previews", workOpts, async (data) => {
          seen.push(data);
        });
        await waitFor(() => seen.length === 1);
        assert.deepEqual(seen, [{ id: "p1" }]);
        await waitFor(async () => {
          const drained = await jobs.counts("previews");
          return drained.waiting === 0 && drained.active === 0 && drained.delayed === 0;
        });
      });
    });

    test("delayMs holds the job until the delay elapses", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const seen: number[] = [];
        await jobs.work("sandbox.hibernate", workOpts, async () => {
          seen.push(Date.now());
        });
        const start = Date.now();
        await jobs.send("sandbox.hibernate", { sandboxId: "sb" }, { delayMs: 400 });
        await waitFor(() => seen.length === 1);
        assert.ok(seen[0]! - start >= 300);
      });
    });

    test("dedupeKey keeps one job until it finishes, then the key is free", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const seen: string[] = [];
        const started = deferred();
        const release = deferred();
        await jobs.work("swarm.publish", workOpts, async (data: { n: string }) => {
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
        await waitFor(async () => {
          const counts = await jobs.counts("swarm.publish");
          return counts.waiting === 0 && counts.active === 0 && seen.length === 1;
        });
        await jobs.send("swarm.publish", { n: "c" }, { dedupeKey: "s1" });
        await waitFor(() => seen.length === 2);
        assert.deepEqual(seen, ["a", "c"]);
      });
    });

    test("coalesceKey keeps one waiting job and queues exactly one rerun while active", { timeout: 20_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const seen: Array<{ n: number }> = [];
        const started = deferred();
        const release = deferred();
        await jobs.work("swarm.tick", workOpts, async (data: { n: number }) => {
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
        release.resolve();
        await waitFor(() => seen.length === 2);
        assert.equal(seen.length, 2);
      });
    });

    test("gate.evaluate coalesceKey keeps one waiting job and queues exactly one rerun while active", { timeout: 20_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const seen: string[] = [];
        const started = deferred();
        const release = deferred();
        await jobs.work("gate.evaluate", workOpts, async (data: { featureId: string }) => {
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
        release.resolve();
        await waitFor(() => seen.length === 2);
        assert.deepEqual(seen, ["feat-1", "feat-1"]);
      });
    });

    test("debounceKey replaces a waiting delayed job and pushes its delay back", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const seen: number[] = [];
        await jobs.work("sandbox.hibernate", workOpts, async (data: { n: number }) => {
          seen.push(data.n);
        });
        await jobs.send("sandbox.hibernate", { n: 1 }, { debounceKey: "sb1", delayMs: 500 });
        await new Promise((r) => setTimeout(r, 150));
        await jobs.send("sandbox.hibernate", { n: 2 }, { debounceKey: "sb1", delayMs: 500 });
        await new Promise((r) => setTimeout(r, 250));
        assert.deepEqual(seen, []);
        await waitFor(() => seen.length === 1);
        assert.deepEqual(seen, [2]);
      });
    });

    test("attempts and backoff retry a failing handler", { timeout: 20_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        let attempts = 0;
        await jobs.work("slack.notify", workOpts, async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("retry me");
        });
        await jobs.send("slack.notify", { type: "created" }, { attempts: 3, backoffMs: 50 });
        await waitFor(() => attempts === 3, 15_000);
        assert.equal(attempts, 3);
      });
    });

    test("schedule upserts and unschedule removes without throwing", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const queue: QueueName = "sandbox.modal-sweep";
        await jobs.schedule(queue, queue, "0 9 * * *", { tag: 1 });
        await jobs.schedule(queue, queue, "0 10 * * *", { tag: 1 });
        await jobs.unschedule(queue);
        await jobs.unschedule(queue);
        const seen: unknown[] = [];
        await jobs.work(queue, workOpts, async (data) => {
          seen.push(data);
        });
        await jobs.send(queue, { tag: "manual" });
        await waitFor(() => seen.length === 1);
        assert.deepEqual(seen, [{ tag: "manual" }]);
      });
    });

    test("counts report waiting, active, and delayed work", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const started = deferred();
        const release = deferred();
        await jobs.work("linear.inbound", workOpts, async () => {
          started.resolve();
          await release.promise;
        });
        await jobs.send("linear.inbound", { a: 1 });
        await started.promise;
        await jobs.send("linear.inbound", { b: 2 });
        await jobs.send("linear.inbound", { c: 3 }, { delayMs: 60_000 });
        const counts = await jobs.counts("linear.inbound");
        assert.equal(counts.active, 1);
        assert.ok(counts.waiting + counts.delayed >= 2, `expected waiting+delayed >= 2, got ${JSON.stringify(counts)}`);
        release.resolve();
      });
    });

    test("work concurrency runs that many jobs at once", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        let active = 0;
        let max = 0;
        const held: Array<() => void> = [];
        await jobs.work("linear.create-issue", { concurrency: 2, pollingIntervalSeconds: 1 }, async () => {
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

    test("stop waits for the active job and then accepts no more work", { timeout: 15_000 }, async () => {
      await withJobs(backend, async (jobs) => {
        const started = deferred();
        let finished = false;
        await jobs.work("gate.evaluate", workOpts, async () => {
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
  });
}
