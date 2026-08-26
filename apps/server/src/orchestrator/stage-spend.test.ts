import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_STAGE_SPEND_EVENT,
  captureStageSpend,
  runsInVisit,
  tallyStageSpend,
} from "./stage-spend.js";
import type { Analytics } from "../analytics.js";
import type { AppContext } from "../context.js";

test("unreported rows do not invent a cost", () => {
  assert.deepEqual(tallyStageSpend([]), { costUsd: 0, runCount: 0, runsWithCost: 0 });
  assert.deepEqual(tallyStageSpend([{ costUsd: null }, { costUsd: null }]), {
    costUsd: 0,
    runCount: 2,
    runsWithCost: 0,
  });
});

test("postgres numeric strings still sum", () => {
  assert.deepEqual(tallyStageSpend([{ costUsd: "0.11" }, { costUsd: "0.42" }, { costUsd: null }]), {
    costUsd: 0.53,
    runCount: 3,
    runsWithCost: 2,
  });
});

test("a visit ignores runs from the last time the card was here", () => {
  const enteredAt = new Date("2026-08-01T12:00:00Z");
  const rows = [
    { costUsd: "1.00", queuedAt: new Date("2026-08-01T11:00:00Z") },
    { costUsd: "0.25", queuedAt: new Date("2026-08-01T12:00:00Z") },
    { costUsd: "0.10", queuedAt: new Date("2026-08-01T13:00:00Z") },
  ];
  assert.deepEqual(tallyStageSpend(runsInVisit(rows, enteredAt)), {
    costUsd: 0.35,
    runCount: 2,
    runsWithCost: 2,
  });
});

test("no entry timestamp counts every run on the stage", () => {
  const rows = [{ costUsd: "0.50", queuedAt: new Date("2026-01-01T00:00:00Z") }];
  assert.equal(runsInVisit(rows, null).length, 1);
});

/** Thenable drizzle chain: each `await` consumes the next canned result. */
function dbFromQueue(results: unknown[][]) {
  let i = 0;
  const obj: Record<string, unknown> = {};
  const next = () => obj;
  obj.select = next;
  obj.from = next;
  obj.where = next;
  obj.orderBy = next;
  obj.limit = next;
  obj.then = (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(results[i++] ?? []).then(onFulfilled, onRejected);
  return obj;
}

const FEATURE = {
  id: "feature-1",
  projectId: "project-1",
  organizationId: "org-1",
};

test("no analytics means no query", async () => {
  let queried = false;
  await captureStageSpend(
    {
      analytics: undefined,
      db: {
        select() {
          queried = true;
          return this;
        },
      },
    } as unknown as AppContext,
    { feature: FEATURE, stageId: "stage-1", trigger: "manual" },
  );
  assert.equal(queried, false);
});

test("a completed stage emits the summed cost of this visit", async () => {
  const captured: Array<{ event: string; userId?: string | null; organizationId?: string | null; properties?: Record<string, unknown> }> =
    [];
  const analytics: Analytics = {
    capture: (event) => captured.push(event),
    captureException: () => {},
    shutdown: async () => {},
  };
  const enteredAt = new Date("2026-08-01T12:00:00Z");
  await captureStageSpend(
    {
      analytics,
      db: dbFromQueue([
        [
          { costUsd: "1.00", queuedAt: new Date("2026-08-01T11:00:00Z") },
          { costUsd: "0.40", queuedAt: new Date("2026-08-01T12:30:00Z") },
          { costUsd: null, queuedAt: new Date("2026-08-01T12:45:00Z") },
        ],
        [{ name: "Build", slug: "build" }],
        [{ at: enteredAt }],
      ]),
    } as unknown as AppContext,
    {
      feature: FEATURE,
      stageId: "stage-1",
      trigger: "gate_auto",
      actorUserId: "user-1",
      toStageId: "stage-2",
    },
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.event, AGENT_STAGE_SPEND_EVENT);
  assert.equal(captured[0]?.userId, "user-1");
  assert.equal(captured[0]?.organizationId, "org-1");
  assert.deepEqual(captured[0]?.properties, {
    cost_usd: 0.4,
    run_count: 2,
    runs_with_cost: 1,
    feature_id: "feature-1",
    stage_id: "stage-1",
    stage_name: "Build",
    stage_slug: "build",
    project_id: "project-1",
    trigger: "gate_auto",
    to_stage_id: "stage-2",
  });
});

test("a query failure does not throw", async () => {
  const analytics: Analytics = {
    capture: () => {
      throw new Error("should not capture");
    },
    captureException: () => {},
    shutdown: async () => {},
  };
  await captureStageSpend(
    {
      analytics,
      db: {
        select() {
          throw new Error("db down");
        },
      },
    } as unknown as AppContext,
    { feature: FEATURE, stageId: "stage-1", trigger: "manual" },
  );
});
