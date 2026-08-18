import { test } from "node:test";
import assert from "node:assert/strict";
import { actorDisplayName, historyTriggerLabel } from "./history.js";

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
