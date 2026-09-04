import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionWords,
  canPause,
  canResume,
  canStop,
  isAttention,
  isSwarmOver,
  swarmTone,
  swarmWords,
  taskTone,
  taskWords,
} from "./swarm/status.js";
import { attentionFor, buildSwarmModel, elapsedFor, outlineRows, LONG_RUN_WARNING_MS } from "./swarm/layout.js";
import { formatElapsed, elapsedSince } from "./swarm/time.js";
import type { SwarmStatus, SwarmTask, TaskStatus } from "./swarm/types.js";

/**
 * Status is one axis and attention is another.
 *
 * The distinction these protect: a worker that has been going for an
 * hour is still `working`, and a leaf asking a question is still
 * doing whatever it was doing. Yellow is painted over the status
 * rather than instead of it, and it has to mean the same thing in the
 * tree, in the outline, and in the drawer.
 */

function leaf(status: TaskStatus, extra: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: extra.id ?? "leaf",
    parentId: extra.parentId ?? null,
    position: 0,
    title: "A leaf",
    description: "",
    kind: "leaf",
    status,
    attention: extra.attention ?? "none",
    weight: 1,
    assignedRunId: null,
    branchName: null,
    cost: { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 },
    flags: {},
    report: null,
    acceptanceCriteria: [],
    startedAt: extra.startedAt ?? null,
    endedAt: extra.endedAt ?? null,
    commits: [],
  };
}

test("every task status resolves to one of the console's five hues", () => {
  const allowed = new Set(["running", "succeeded", "failed", "gated", "idle"]);
  const statuses: TaskStatus[] = [
    "open",
    "assigned",
    "working",
    "landed",
    "done",
    "blocked",
    "failed",
    "cancelled",
  ];
  for (const status of statuses) assert.ok(allowed.has(taskTone(status)), status);
  assert.equal(taskTone("working"), "running");
  assert.equal(taskTone("assigned"), "running");
  // Landed is merged, not finished: only done is allowed to be green.
  assert.equal(taskTone("landed"), "running");
  assert.equal(taskTone("done"), "succeeded");
  assert.equal(taskTone("blocked"), "gated");
  assert.equal(taskTone("failed"), "failed");
  assert.equal(taskTone("open"), "idle");
  assert.equal(taskTone("cancelled"), "idle");
});

test("every swarm status resolves to one of the same five, and is called something", () => {
  const statuses: SwarmStatus[] = [
    "planning",
    "running",
    "paused",
    "waiting",
    "done",
    "stopped",
    "budget_exhausted",
    "failed",
  ];
  const allowed = new Set(["running", "succeeded", "failed", "gated", "idle"]);
  for (const status of statuses) {
    assert.ok(allowed.has(swarmTone(status)), status);
    // No underscores reach a person: the strip prints these.
    assert.ok(!swarmWords(status).includes("_"), status);
  }
  assert.equal(swarmWords("budget_exhausted"), "out of budget");
  assert.equal(swarmWords("waiting"), "waiting for you");
  assert.equal(swarmTone("budget_exhausted"), "gated");
  assert.equal(swarmTone("planning"), "running");
  assert.equal(swarmTone("stopped"), "idle");
});

test("attention is not a status: the same status carries either answer", () => {
  const plain = leaf("working");
  const yellow = leaf("working", { attention: "escalated" });
  assert.equal(plain.status, yellow.status);
  assert.equal(isAttention(plain.attention), false);
  assert.equal(isAttention(yellow.attention), true);
  // And the hue for the status is unchanged by it.
  assert.equal(taskTone(plain.status), taskTone(yellow.status));
  assert.equal(attentionWords("none"), null);
  assert.equal(attentionWords("long_running"), "running long");
  assert.equal(attentionWords("escalated"), "needs you");
});

test("attention survives the switch from tree to outline", () => {
  const tasks = [
    leaf("working", { id: "root" }),
    leaf("working", { id: "slow", parentId: "root", startedAt: new Date(0).toISOString() }),
    leaf("blocked", { id: "stuck", parentId: "root", attention: "escalated" }),
  ];
  const model = buildSwarmModel(tasks, { now: LONG_RUN_WARNING_MS + 1 });
  const rows = outlineRows(model);
  const rowFor = (id: string) => rows.find((row) => row.id === id)!;

  for (const id of ["root", "slow", "stuck"]) {
    assert.equal(rowFor(id).attention, model.byId.get(id)!.attention, id);
    assert.equal(rowFor(id).status, model.byId.get(id)!.status, id);
  }
  assert.equal(rowFor("slow").attention, "long_running");
  assert.equal(rowFor("slow").status, "working");
  assert.equal(rowFor("stuck").attention, "escalated");
  assert.equal(rowFor("stuck").status, "blocked");
  // The root is only working; nobody has raised anything on it.
  assert.equal(rowFor("root").attention, "none");
});

test("the clock only ever raises attention, and only for a working leaf", () => {
  const started = new Date(0).toISOString();
  const past = LONG_RUN_WARNING_MS + 1;
  assert.equal(attentionFor(leaf("working", { startedAt: started }), past), "long_running");
  assert.equal(attentionFor(leaf("assigned", { startedAt: started }), past), "long_running");
  // A leaf that finished long ago is not a long running leaf.
  assert.equal(
    attentionFor(leaf("done", { startedAt: started, endedAt: new Date(60_000).toISOString() }), past),
    "none",
  );
  assert.equal(attentionFor(leaf("open"), past), "none");
  // An escalation is never quietly downgraded by the clock.
  assert.equal(attentionFor(leaf("working", { attention: "escalated", startedAt: started }), past), "escalated");
  // Nor is one raised early.
  assert.equal(attentionFor(leaf("working", { startedAt: started }), LONG_RUN_WARNING_MS - 1), "none");
});

test("elapsed stops at the end rather than counting forever", () => {
  const task = leaf("done", { startedAt: new Date(0).toISOString(), endedAt: new Date(90_000).toISOString() });
  assert.equal(elapsedFor(task, 10_000_000), 90_000);
  assert.equal(elapsedFor(leaf("working", { startedAt: new Date(0).toISOString() }), 5_000), 5_000);
  assert.equal(elapsedFor(leaf("open"), 5_000), 0);
  assert.equal(elapsedFor(leaf("working", { startedAt: "not a date" }), 5_000), 0);
});

test("elapsed reads in the unit the number is actually in", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(1_000), "1s");
  assert.equal(formatElapsed(59_000), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(90_000), "1m 30s");
  assert.equal(formatElapsed(59 * 60_000), "59m 0s");
  assert.equal(formatElapsed(60 * 60_000), "1h 0m");
  assert.equal(formatElapsed(184 * 60_000), "3h 4m");
  assert.equal(elapsedSince(new Date(1000).toISOString(), 61_000), 60_000);
  assert.equal(elapsedSince(null, 61_000), 0);
});

test("the controls a swarm offers follow the state it is in", () => {
  assert.equal(canPause("running"), true);
  assert.equal(canPause("planning"), true);
  assert.equal(canPause("waiting"), true);
  assert.equal(canPause("paused"), false);
  assert.equal(canPause("done"), false);
  assert.equal(canResume("paused"), true);
  assert.equal(canResume("budget_exhausted"), true);
  assert.equal(canResume("running"), false);
  assert.equal(canStop("running"), true);
  assert.equal(canStop("done"), false);
  assert.equal(isSwarmOver("stopped"), true);
  assert.equal(isSwarmOver("failed"), true);
  assert.equal(isSwarmOver("paused"), false);
  assert.equal(taskWords("landed"), "landed");
});
