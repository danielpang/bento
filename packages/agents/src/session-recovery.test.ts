import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@bento/core";
import { claudeCodeAdapter } from "./claude-code.js";
import { opencodeAdapter } from "./opencode.js";

/**
 * The fixtures mirror the real formats, verified by hand: `opencode
 * export` output from opencode 1.18, and ~/.claude/projects session
 * files from claude 2.x. A format drift breaks these tests before it
 * silently breaks recovery.
 */

const opencodeExport = JSON.stringify({
  info: { id: "ses_abc", directory: "/w/bento" },
  messages: [
    {
      info: { role: "user", id: "msg_u1" },
      parts: [{ type: "text", text: "please fix it", id: "prt_u1", messageID: "msg_u1" }],
    },
    {
      info: { role: "assistant", id: "msg_a1" },
      parts: [
        { type: "step-start", id: "prt_s1", messageID: "msg_a1" },
        { type: "text", text: "Looking at the bug now.", id: "prt_a1", messageID: "msg_a1" },
        { type: "tool", tool: "read", id: "prt_t1", messageID: "msg_a1" },
      ],
    },
    {
      info: { role: "assistant", id: "msg_a2" },
      parts: [{ type: "text", text: "Fixed and committed.", id: "prt_a2", messageID: "msg_a2" }],
    },
  ],
});

test("opencode recovery reads assistant text parts out of an export", () => {
  const recovery = opencodeAdapter.sessionRecovery!;
  assert.deepEqual(recovery.readLogCommand("ses_abc", "/w/bento"), ["opencode", "export", "ses_abc"]);

  const held = recovery.parseLog(opencodeExport);
  assert.deepEqual(
    held.map((m) => m.text),
    ["Looking at the bug now.", "Fixed and committed."],
    "user turns, step markers, and tool parts stay out",
  );

  // Round trip: a recovered message carries the same ids a streamed
  // one does, so a later recovery sees it as already delivered.
  const first = held[0]!;
  const ids = recovery.persistedIds({ type: "message", role: "assistant", text: first.text, raw: first.raw });
  assert.deepEqual(ids, ["prt_a1", "msg_a1"]);

  // And the ids match what the live stream persists: raw.part carries
  // the part id and message id on every "text" line.
  const streamed: AgentEvent = {
    type: "message",
    role: "assistant",
    text: "Looking at the bug now.",
    raw: { type: "text", part: { id: "prt_a1", messageID: "msg_a1", type: "text", text: "Looking at the bug now." } },
  };
  assert.deepEqual(recovery.persistedIds(streamed), ["prt_a1", "msg_a1"]);

  assert.deepEqual(recovery.parseLog("not json"), [], "a broken export recovers nothing rather than throwing");
});

const claudeSessionLines = [
  JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: "sid-1" }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "please fix it" }] },
    uuid: "u-1",
    sessionId: "sid-1",
  }),
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_A", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    uuid: "u-2",
    sessionId: "sid-1",
  }),
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_A", role: "assistant", content: [{ type: "text", text: "Starting on the fix." }] },
    uuid: "u-3",
    sessionId: "sid-1",
  }),
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_A", role: "assistant", content: [{ type: "text", text: "One file needs a change." }] },
    uuid: "u-4",
    sessionId: "sid-1",
  }),
  JSON.stringify({
    type: "assistant",
    isSidechain: true,
    message: { id: "msg_side", role: "assistant", content: [{ type: "text", text: "subagent chatter" }] },
    uuid: "u-5",
    sessionId: "sid-1",
  }),
  JSON.stringify({
    type: "assistant",
    message: { id: "msg_B", role: "assistant", content: [{ type: "text", text: "Done, tests pass." }] },
    uuid: "u-6",
    sessionId: "sid-1",
  }),
].join("\n");

test("claude-code recovery reads its session file and groups by message id", () => {
  const recovery = claudeCodeAdapter.sessionRecovery!;

  const [cmd, flag, script] = recovery.readLogCommand("abc-123", "/Users/d_pang/projects/bento");
  assert.equal(cmd, "sh");
  assert.equal(flag, "-c");
  assert.match(
    script!,
    /\.claude\/projects\/-Users-d-pang-projects-bento\/abc-123\.jsonl/,
    "the slug replaces every non-alphanumeric character, underscores included",
  );

  const held = recovery.parseLog(claudeSessionLines);
  assert.deepEqual(
    held.map((m) => m.text),
    ["Starting on the fix.\nOne file needs a change.", "Done, tests pass."],
    "entries sharing a message id merge; sidechains and thinking-only entries stay out",
  );

  const ids = recovery.persistedIds({ type: "message", role: "assistant", text: held[0]!.text, raw: held[0]!.raw });
  assert.deepEqual(ids, ["msg_A"], "recovered messages carry the API message id");

  // The live stream's persisted shape carries the same id.
  const streamed: AgentEvent = {
    type: "message",
    role: "assistant",
    text: "Starting on the fix.",
    raw: { type: "assistant", message: { id: "msg_A", content: [{ type: "text", text: "Starting on the fix." }] } },
  };
  assert.deepEqual(recovery.persistedIds(streamed), ["msg_A"]);

  assert.deepEqual(recovery.persistedIds({ type: "message", role: "user", text: "hi" }), [], "user lines have no recovery identity");
});
