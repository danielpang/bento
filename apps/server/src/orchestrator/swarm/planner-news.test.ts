import assert from "node:assert/strict";
import test from "node:test";
import { leafReview, leafReviewerId, MAX_PLANNER_RETELLS } from "./planner-news.js";

const RUN = "6d429181-0000-4000-8000-000000000000";
const reported = {
  nodeType: "leaf" as const,
  status: "working" as const,
  report: "Built the web shell.",
  flags: {} as Record<string, unknown>,
};
const told = (extra: Record<string, unknown> = {}) => ({
  ...reported,
  flags: { plannerToldAt: "2026-10-14T22:50:00.000Z", plannerToldBy: RUN, ...extra },
});

test("a report nobody has handed over is waiting for the planner", () => {
  assert.equal(leafReview(reported, null), "waiting");
  assert.equal(leafReview(told(), null), "waiting", "a reviewer the server cannot find is not reviewing");
});

test("a report handed to an active planner is being reviewed", () => {
  for (const status of ["queued", "starting", "running"]) assert.equal(leafReview(told(), status), "reviewing", status);
});

test("a report whose planner ended undecided says what the coordinator does next", () => {
  assert.equal(leafReview(told(), "failed"), "restarting");
  assert.equal(leafReview(told(), "cancelled"), "stopped");
  assert.equal(leafReview(told(), "succeeded"), "waiting", "handed over again after a turn that did not decide it");
  for (const status of ["failed", "cancelled", "succeeded"]) {
    assert.equal(leafReview(told({ plannerRetells: MAX_PLANNER_RETELLS }), status), "undecided", status);
  }
});

test("only a reported leaf still waiting on a verdict has a review", () => {
  assert.equal(leafReview({ ...reported, nodeType: "plan" }, null), null);
  assert.equal(leafReview({ ...reported, report: null }, null), null);
  assert.equal(leafReview({ ...reported, report: "  " }, null), null);
  assert.equal(leafReview({ ...reported, status: "done" }, null), null);
  assert.equal(leafReview(told({ accepted: true }), "running"), null, "accepted is the merge queue's");
  assert.equal(leafReview(told({ landingError: "conflict" }), "running"), null);
});

test("the reviewer is read only from a well formed run id", () => {
  assert.equal(leafReviewerId({ plannerToldBy: RUN }), RUN);
  assert.equal(leafReviewerId({ plannerToldBy: "not a uuid" }), null);
  assert.equal(leafReviewerId({}), null);
  assert.equal(leafReviewerId(null), null);
});
