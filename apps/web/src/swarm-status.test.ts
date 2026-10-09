import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionNote,
  attentionWords,
  canPause,
  canResume,
  canStart,
  canStop,
  ceilingAction,
  diagramAttentionWords,
  diagramTaskTone,
  diagramTaskWords,
  isAttention,
  isSwarmOver,
  pausedWords,
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
    nodeType: "leaf",
    status,
    attention: extra.attention ?? "none",
    weight: 1,
    assignedRunId: null,
    agentProfileId: extra.agentProfileId ?? null,
    branchName: null,
    cost: { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0},
    flags: {},
    report: null,
    acceptanceCriteria: [],
    followUpInstruction: extra.followUpInstruction ?? null,
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

test("a failed descendant leaves its plan stalled without a duplicate failure label", () => {
  assert.equal(diagramTaskWords("failed", "plan"), "stalled");
  assert.equal(diagramTaskTone("failed", "plan"), "gated");
  assert.equal(diagramTaskWords("failed", "leaf"), "failed");
  assert.equal(diagramTaskTone("failed", "leaf"), "failed");
  assert.equal(diagramAttentionWords("failed", "leaf", "failed"), null);
  assert.equal(diagramAttentionWords("working", "leaf", "long_running", true), "Still running");
  assert.equal(diagramAttentionWords("working", "leaf", "long_running"), null, "a wait is not an agent that is still running");
  assert.equal(diagramAttentionWords("blocked", "leaf", "escalated"), "Planner notified of long run task");
});

test("a task says working only while an agent is running, and pending or completed otherwise", () => {
  assert.equal(diagramTaskWords("assigned", "leaf"), "pending");
  assert.equal(diagramTaskWords("open", "leaf"), "pending");
  assert.equal(diagramTaskWords("working", "leaf"), "pending");
  assert.equal(diagramTaskWords("working", "plan"), "pending");
  assert.equal(diagramTaskTone("assigned", "leaf"), "idle");
  assert.equal(diagramTaskTone("working", "plan"), "idle");
  assert.equal(diagramTaskWords("working", "leaf", false, "waiting"), "waiting to land", "an accepted leaf is not pending");
  assert.equal(diagramTaskWords("working", "leaf", false, "failed"), "landing failed");
  assert.equal(diagramTaskWords("working", "leaf", false, "review"), "waiting for review", "a reported leaf is not pending");
  assert.equal(diagramTaskTone("working", "leaf", false, "review"), "idle");
  assert.equal(diagramTaskWords("working", "leaf", true, "review"), "working", "an agent in the sandbox is working");
  assert.equal(diagramTaskTone("working", "leaf", false, "failed"), "failed");
  assert.equal(diagramTaskWords("working", "leaf", true), "working");
  assert.equal(diagramTaskTone("working", "leaf", true), "running");
  assert.equal(diagramTaskWords("landed", "leaf", true), "working", "a resolver is an agent in the sandbox");
  assert.equal(diagramTaskTone("landed", "leaf", true), "running");
  assert.equal(diagramTaskWords("failed", "leaf", true), "working");
  assert.equal(diagramTaskWords("failed", "plan", true), "working");
  assert.equal(diagramTaskWords("failed", "plan"), "stalled");
  assert.equal(diagramTaskWords("done", "leaf"), "completed");
  assert.equal(diagramTaskTone("done", "leaf"), "succeeded");
  assert.equal(diagramTaskWords("landed", "leaf"), "landed");
  assert.equal(diagramTaskWords("cancelled", "leaf"), "cancelled");
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
  assert.equal(swarmWords("budget_exhausted"), "Budget limit reached");
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
  assert.equal(attentionWords("long_running"), "Still running");
  assert.equal(attentionWords("escalated"), "Planner notified of long run task");
  /*
   * One sentence per reason, which is the point of carrying the
   * server's own word through. They all read "needs you" once, which
   * is true of every one of them and useful about none: a conflict
   * wants a resolver, a question wants an answer, and a swarm out of
   * money wants a decision about money.
   */
  assert.equal(attentionWords("question"), "Waiting for user approval");
  assert.equal(attentionWords("conflict"), "Merge conflict");
  assert.equal(attentionWords("budget"), "Budget limit reached");
  assert.equal(attentionWords("plan_limit"), "Out of Bento agent hours, enable overage billing to continue");
});

test("budget and agent-hours warnings use the same copy in task drawers and swarm banners", () => {
  assert.equal(attentionNote("budget"), pausedWords("budget_exhausted", null));
  assert.equal(attentionNote("budget"), pausedWords("paused", "budget"));
  assert.equal(attentionNote("plan_limit"), pausedWords("paused", "plan_limit"));
  assert.equal(pausedWords("timed_out", null), pausedWords("paused", "time_limit"));
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
  // The live clock is the agent's start, and only while it is running.
  const agentStarted = new Date(LONG_RUN_WARNING_MS).toISOString();
  assert.equal(
    attentionFor(leaf("working", { startedAt: started, attention: "long_running" }), past, LONG_RUN_WARNING_MS, { active: false, startedAt: null }),
    "none",
    "a clock flag does not survive an agent that is not in the sandbox",
  );
  assert.equal(
    attentionFor(leaf("landed", { startedAt: started }), past, LONG_RUN_WARNING_MS, { active: true, startedAt: agentStarted }),
    "none",
    "time before the agent started does not count",
  );
  assert.equal(
    attentionFor(leaf("landed", { startedAt: started }), past + LONG_RUN_WARNING_MS, LONG_RUN_WARNING_MS, { active: true, startedAt: agentStarted }),
    "long_running",
  );
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
  // The start route refuses both ceilings: raising one is what moves it.
  assert.equal(canResume("budget_exhausted"), false);
  assert.equal(canResume("timed_out"), false);
  assert.equal(ceilingAction("budget_exhausted"), "Raise budget");
  assert.equal(ceilingAction("timed_out"), "Raise time limit");
  assert.equal(ceilingAction("paused"), null);
  assert.equal(canResume("running"), false);
  /*
   * Starting is not resuming, and a planned swarm needs it.
   *
   * A swarm is created in planning and stays there until a person
   * says the plan is worth running. Every door the console had for
   * starting work was behind canResume, which planning is not, so the
   * one action that swarm needed was never on screen.
   */
  assert.equal(canStart("planning"), true);
  assert.equal(canStart("running"), false);
  assert.equal(canStart("paused"), false, "that is Resume, and it says Resume");
  assert.equal(canStart("done"), false);
  assert.equal(canStop("running"), true);
  assert.equal(canStop("done"), false);
  assert.equal(isSwarmOver("stopped"), true);
  assert.equal(isSwarmOver("failed"), true);
  assert.equal(isSwarmOver("paused"), false);
  assert.equal(taskWords("landed"), "landed");
});
