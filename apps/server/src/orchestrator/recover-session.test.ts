import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter, opencodeAdapter } from "@bento/agents";
import type { AgentEvent } from "@bento/core";
import { isPersisted } from "./recover-session.js";

/**
 * The live filter on a reattached stream decides what a deploy costs:
 * a match drops the line, a miss appends it. Every id has to match,
 * because opencode names a text part by its own id and then by its
 * message, and a message keeps gaining parts after its first was
 * persisted.
 */
test("a later part of an opencode message the transcript already holds is not dropped", () => {
  const recovery = opencodeAdapter.sessionRecovery!;
  const part = (id: string, text: string): AgentEvent => ({
    type: "message",
    role: "assistant",
    text,
    raw: { type: "text", part: { id, messageID: "msg_1", type: "text", text } },
  });
  const seen = new Set(recovery.persistedIds(part("prt_1", "Looking at the bug.")));

  assert.equal(isPersisted(recovery, seen, part("prt_1", "Looking at the bug.")), true, "the part itself is a replay");
  assert.equal(isPersisted(recovery, seen, part("prt_2", "Fixed it.")), false, "a new part of the same message is new");
});

test("a claude-code line is a replay when its message id is known, and unknown lines are the caller's call", () => {
  const recovery = claudeCodeAdapter.sessionRecovery!;
  const said = (id: string): AgentEvent => ({
    type: "message",
    role: "assistant",
    text: "hi",
    raw: { type: "assistant", message: { id, content: [{ type: "text", text: "hi" }] } },
  });
  const seen = new Set(["msg_A", "tool_use:toolu_1"]);
  assert.equal(isPersisted(recovery, seen, said("msg_A")), true);
  assert.equal(isPersisted(recovery, seen, said("msg_B")), false);

  const anonymous: AgentEvent = { type: "message", role: "assistant", text: "no raw, no id" };
  assert.equal(isPersisted(recovery, seen, anonymous), false, "a live line without an id is delivered");
  assert.equal(
    isPersisted(recovery, seen, anonymous, { unknownIs: "persisted" }),
    true,
    "a held message without an id is never recovered",
  );
});
