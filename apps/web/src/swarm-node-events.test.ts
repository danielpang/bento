import { test } from "node:test";
import assert from "node:assert/strict";
import { eventNote, eventWords } from "./components/SwarmNodeDrawer.js";
import type { SwarmTaskEvent } from "./swarm/types.js";

const event = (overrides: Partial<SwarmTaskEvent>): SwarmTaskEvent => ({
  id: "e1",
  kind: "note",
  at: "2026-10-08T21:00:00.000Z",
  fromStatus: null,
  toStatus: null,
  runId: null,
  detail: null,
  ...overrides,
});

test("a worker's log says when a planner is reviewing its work, and what it decided", () => {
  assert.equal(eventWords(event({ kind: "reported" })), "Worker reported");
  assert.equal(eventWords(event({ kind: "review_requested", runId: "p1" })), "Planner reviewing");
  assert.equal(eventWords(event({ kind: "review_interrupted", runId: "p1" })), "Planner review interrupted");
  assert.equal(eventWords(event({ kind: "note", detail: { accepted: true, note: "Looks right" } })), "Planner accepted");
  assert.equal(eventWords(event({ kind: "note", detail: { note: "anything else" } })), "Note");
});

test("a planner's reject reads as the planner sending it back, with its reason", () => {
  const rejected = event({
    kind: "status_changed",
    toStatus: "assigned",
    runId: "p1",
    detail: { retry: 2, rejection: "Run the full suite.\nThen report again.", rejected: true },
  });
  assert.equal(eventWords(rejected), "Planner sent it back");
  assert.equal(eventNote(rejected), "Run the full suite.");

  // A failed leaf the planner assigns again with a reason writes the same
  // status change and text, but no report was sent back.
  const reassigned = event({
    kind: "status_changed",
    fromStatus: "failed",
    toStatus: "assigned",
    runId: "p1",
    detail: { retry: 1, rejection: "Use the staging database." },
  });
  assert.equal(eventWords(reassigned), "Queued for worker");

  // A retry a person pressed carries no reason and is still a plain retry.
  assert.equal(eventWords(event({ kind: "status_changed", toStatus: "assigned", detail: { retry: 1 } })), "Queued for worker");
});
