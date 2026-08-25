import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_QUEUE_SNAPSHOT_EVENT,
  captureRunQueueDepth,
  tallyServerRunCounts,
} from "./queue-snapshot.js";
import type { AppContext } from "../context.js";
import type { Analytics } from "../analytics.js";

test("queued stays queued, starting and running are busy", () => {
  assert.deepEqual(
    tallyServerRunCounts([
      { status: "queued", n: 7 },
      { status: "starting", n: 2 },
      { status: "running", n: 5 },
    ]),
    { queued: 7, busy: 7 },
  );
});

test("an empty tally is a quiet queue", () => {
  assert.deepEqual(tallyServerRunCounts([]), { queued: 0, busy: 0 });
});

test("postgres count strings still tally", () => {
  assert.deepEqual(tallyServerRunCounts([{ status: "queued", n: "3" as unknown as number }]), {
    queued: 3,
    busy: 0,
  });
});

test("no analytics means no query", async () => {
  let queried = false;
  await captureRunQueueDepth({
    analytics: undefined,
    db: {
      select() {
        queried = true;
        return this;
      },
    },
    env: { BENTO_MAX_CONCURRENT_RUNS: 32 },
  } as unknown as AppContext);
  assert.equal(queried, false);
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
    db: {
      select() {
        return this;
      },
      from() {
        return this;
      },
      where() {
        return this;
      },
      groupBy: async () => [
        { status: "queued", n: 4 },
        { status: "running", n: 32 },
      ],
    },
    env: { BENTO_MAX_CONCURRENT_RUNS: 32 },
  } as unknown as AppContext);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.event, RUN_QUEUE_SNAPSHOT_EVENT);
  assert.deepEqual(captured[0]?.properties, { queued: 4, busy: 32, workers: 32 });
});
