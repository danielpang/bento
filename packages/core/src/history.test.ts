import { test } from "node:test";
import assert from "node:assert/strict";
import { actorDisplayName, historyTriggerLabel, needsSendBackPrompt, SEND_BACK_NOTICE } from "./history.js";

test("a real name beats the email", () => {
  assert.equal(actorDisplayName("Ada Lovelace", "ada@bento.test"), "Ada Lovelace");
});

test("an empty or email-shaped name falls through to the email", () => {
  assert.equal(actorDisplayName("", "ada@bento.test"), "ada@bento.test");
  assert.equal(actorDisplayName("   ", "ada@bento.test"), "ada@bento.test");
  assert.equal(actorDisplayName("ada@bento.test", "ada@bento.test"), "ada@bento.test");
  assert.equal(actorDisplayName(null, "ada@bento.test"), "ada@bento.test");
});

test("nothing to name returns null so the caller can say a person", () => {
  assert.equal(actorDisplayName(null, null), null);
  assert.equal(actorDisplayName("", ""), null);
});

test("manual history names the actor when one is known", () => {
  assert.equal(historyTriggerLabel("manual", "Ada Lovelace"), "by Ada Lovelace");
  assert.equal(historyTriggerLabel("manual", "ada@bento.test"), "by ada@bento.test");
  assert.equal(historyTriggerLabel("manual", null), "by a person");
  assert.equal(historyTriggerLabel("manual_back", "Ada Lovelace"), "sent back by Ada Lovelace");
  assert.equal(historyTriggerLabel("manual_back", null), "sent back");
});

test("automated moves keep their own words", () => {
  assert.equal(historyTriggerLabel("gate_auto", "Ada Lovelace"), "by a gate");
  assert.equal(historyTriggerLabel("gate_auto_back", null), "returned by a gate");
  assert.equal(historyTriggerLabel("agent_run", null), "by an agent");
  assert.equal(historyTriggerLabel("system", null), "automatic");
});

const moved = (trigger: string, at: string, kind = "stage_moved") => ({ kind, trigger, at });
const run = (stageId: string, queuedAt: string, kind: string | null = "task") => ({
  kind,
  stageId,
  queuedAt,
});

test("a card sent back asks the person to tell the agent what to do next", () => {
  assert.equal(SEND_BACK_NOTICE, "Card moved back, please tell the agent what to do next");
  assert.equal(
    needsSendBackPrompt({
      status: "active",
      currentStageId: "review",
      history: [moved("manual", "2026-01-01T10:00:00.000Z"), moved("manual_back", "2026-01-01T11:00:00.000Z")],
      runs: [run("qa", "2026-01-01T10:30:00.000Z")],
    }),
    true,
  );
});

test("a follow-up on the destination stage clears the send-back prompt", () => {
  assert.equal(
    needsSendBackPrompt({
      status: "active",
      currentStageId: "review",
      history: [moved("manual_back", "2026-01-01T11:00:00.000Z")],
      runs: [run("qa", "2026-01-01T10:30:00.000Z"), run("review", "2026-01-01T11:01:00.000Z")],
    }),
    false,
  );
});

test("a judge run on the destination does not count as telling the agent", () => {
  assert.equal(
    needsSendBackPrompt({
      status: "active",
      currentStageId: "review",
      history: [moved("manual_back", "2026-01-01T11:00:00.000Z")],
      runs: [run("review", "2026-01-01T11:01:00.000Z", "judge")],
    }),
    true,
  );
});

test("a gate sending a card back does not ask the person to start a conversation", () => {
  assert.equal(
    needsSendBackPrompt({
      status: "active",
      currentStageId: "impl",
      history: [moved("gate_auto_back", "2026-01-01T11:00:00.000Z")],
      runs: [run("qa", "2026-01-01T10:30:00.000Z")],
    }),
    false,
  );
});

test("a finished card does not keep the send-back prompt", () => {
  assert.equal(
    needsSendBackPrompt({
      status: "done",
      currentStageId: "review",
      history: [moved("manual_back", "2026-01-01T11:00:00.000Z")],
      runs: [],
    }),
    false,
  );
});

test("a card sent back to the backlog still asks for the next conversation", () => {
  assert.equal(
    needsSendBackPrompt({
      status: "active",
      currentStageId: null,
      history: [moved("manual_back", "2026-01-01T11:00:00.000Z")],
      runs: [run("impl", "2026-01-01T10:30:00.000Z")],
    }),
    true,
  );
});
