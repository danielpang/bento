import assert from "node:assert/strict";
import test from "node:test";
import { plannerConversationEvents, plannerMessageRun } from "./swarm/planner-conversation.js";
import type { SwarmPlannerMessage } from "./swarm/client.js";
import type { SwarmPlannerHistoryRun } from "./swarm/types.js";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 4, 12) + minute * 60_000).toISOString();
const message = (id: string, minute: number, status: SwarmPlannerMessage["status"] = "delivered"): SwarmPlannerMessage => ({
  id, text: "Please continue", createdAt: at(minute), status, runId: "retry", taskId: null, source: "person",
});
const runs: SwarmPlannerHistoryRun[] = [
  { id: "original", queuedAt: at(1), endedAt: at(5) },
  { id: "retry", queuedAt: at(6), endedAt: null },
];

test("repeated guidance remains visible while queued, sent and delivered", () => {
  for (const status of ["queued", "sent", "delivered"] as const) {
    const conversation = plannerConversationEvents([
      { type: "message", role: "user", text: "A worker report quoted Please continue", recordedAt: at(1) },
      { type: "message", role: "assistant", text: "The first reply", recordedAt: at(2) },
      { type: "message", role: "user", text: "A wake quoted Please continue again", recordedAt: at(4) },
      { type: "message", role: "assistant", text: "The second reply", recordedAt: at(5) },
    ], [message("second", 3, status), message("first", 0)]);
    assert.deepEqual(conversation.messages.map((row) => row.id), ["first", "second"]);
    assert.deepEqual(conversation.events.map((event) => event.type === "message" ? event.text : event.type), [
      "Please continue", "The first reply", "Please continue", "The second reply",
    ]);
  }
});

test("retrying delivery never moves original guidance below the failed planner's reply", () => {
  for (const status of ["queued", "sent", "delivered"] as const) {
    const guidance = message("original-question", 0, status);
    assert.equal(plannerMessageRun(guidance, runs, "retry"), "original");
    const conversation = plannerConversationEvents([
      { type: "message", role: "assistant", text: "A reply before failure", recordedAt: at(3) },
      { type: "result", ok: false, recordedAt: at(5) },
    ], [guidance]);
    assert.equal(conversation.events[0]?.type, "message");
    assert.equal(conversation.events[0]?.type === "message" && conversation.events[0].text, guidance.text);
  }
  assert.equal(plannerMessageRun(message("during-original", 4), runs, "retry"), "original");
  assert.equal(plannerMessageRun(message("between-runs", 5.5), runs, "retry"), "retry");
  assert.equal(plannerMessageRun(message("during-retry", 7), runs, "retry"), "retry");
});

test("old terminal runs without an end stamp are bounded by the next run", () => {
  assert.equal(plannerMessageRun(message("later", 7), [{ ...runs[0]!, endedAt: null }, runs[1]!], "retry"), "retry");
  assert.equal(plannerMessageRun({ ...message("legacy", 0), runId: "legacy-run" }, undefined, "retry"), "legacy-run");
  assert.equal(plannerMessageRun({ ...message("unbound", 0), runId: null }, undefined, "retry"), "retry");
});

test("a page prepend preserves message identity and the original time position", () => {
  const guidance = message("question", 3);
  const tail = [{ type: "message", role: "assistant", text: "Later reply", recordedAt: at(4) }] as const;
  const first = plannerConversationEvents([...tail], [guidance]);
  const expanded = plannerConversationEvents([
    { type: "message", role: "assistant", text: "Earlier reply", recordedAt: at(2) }, ...tail,
  ], [guidance]);
  assert.equal(first.messages[0]?.id, expanded.messages[0]?.id);
  assert.deepEqual(expanded.events.map((event) => event.type === "message" ? event.text : event.type), [
    "Earlier reply", "Please continue", "Later reply",
  ]);
});

test("queued guidance is not hidden on a legacy server without event timestamps", () => {
  const conversation = plannerConversationEvents([
    { type: "message", role: "user", text: "Please continue" },
    { type: "message", role: "assistant", text: "Earlier reply" },
  ], [message("new-question", 3, "queued")]);
  assert.deepEqual(conversation.events.map((event) => event.type === "message" ? event.text : event.type), [
    "Earlier reply", "Please continue",
  ]);
});
