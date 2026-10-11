import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_QUEUE_SNAPSHOT_EVENT,
  captureRunQueueDepth,
  snapshotFromQueueCounts,
} from "./queue-snapshot.js";
import type { AppContext } from "../context.js";
import type { Analytics } from "../analytics.js";
import { FakeJobQueue } from "../jobs/index.js";
import type { JobCounts } from "../jobs/types.js";

function jobsWithCounts(counts: JobCounts): FakeJobQueue {
  const jobs = new FakeJobQueue();
  jobs.counts = async () => counts;
  return jobs;
}

test("waiting and delayed are queued, active is busy", () => {
  assert.deepEqual(snapshotFromQueueCounts({ waiting: 7, active: 5, delayed: 2 }), {
    queued: 9,
    busy: 5,
  });
});

test("an empty tally emits nothing", () => {
  assert.equal(snapshotFromQueueCounts({ waiting: 0, active: 0, delayed: 0 }), null);
});

test("no analytics means no queue read", async () => {
  let counted = false;
  const jobs = new FakeJobQueue();
  jobs.counts = async () => {
    counted = true;
    return { waiting: 1, active: 0, delayed: 0 };
  };
  await captureRunQueueDepth({
    analytics: undefined,
    jobs,
    env: { BENTO_MAX_CONCURRENT_RUNS: 32 },
  } as unknown as AppContext);
  assert.equal(counted, false);
});

test("an empty queue emits nothing", async () => {
  const captured: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  const analytics: Analytics = {
    capture: (event) => captured.push(event),
    captureException: () => {},
    shutdown: async () => {},
  };
  await captureRunQueueDepth({
    analytics,
    jobs: jobsWithCounts({ waiting: 0, active: 0, delayed: 0 }),
    env: { BENTO_MAX_CONCURRENT_RUNS: 32 },
  } as unknown as AppContext);
  assert.deepEqual(captured, []);
});

test("a snapshot names the queued depth and this process's workers", async () => {
  const captured: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  const analytics: Analytics = {
    capture: (event) => captured.push(event),
    captureException: () => {},
    shutdown: async () => {},
  };
  await captureRunQueueDepth({
    analytics,
    jobs: jobsWithCounts({ waiting: 4, active: 32, delayed: 0 }),
    env: { BENTO_MAX_CONCURRENT_RUNS: 32 },
  } as unknown as AppContext);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.event, RUN_QUEUE_SNAPSHOT_EVENT);
  assert.deepEqual(captured[0]?.properties, { queued: 4, busy: 32, workers: 32 });
});

test("a snapshot names the machine and app when the platform says", async () => {
  const captured: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  const analytics: Analytics = {
    capture: (event) => captured.push(event),
    captureException: () => {},
    shutdown: async () => {},
  };
  await captureRunQueueDepth({
    analytics,
    jobs: jobsWithCounts({ waiting: 1, active: 0, delayed: 0 }),
    env: {
      BENTO_MAX_CONCURRENT_RUNS: 32,
      FLY_APP_NAME: "bento-production",
      FLY_MACHINE_ID: "148e21eb4d1289",
    },
  } as unknown as AppContext);
  assert.deepEqual(captured[0]?.properties, {
    queued: 1,
    busy: 0,
    workers: 32,
    app: "bento-production",
    instance: "148e21eb4d1289",
  });
});
