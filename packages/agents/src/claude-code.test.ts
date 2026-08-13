import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter } from "./claude-code.js";
import { fakeAdapter } from "./fake.js";
import type { AgentEvent } from "@bento/core";

const transcript = [
  `{"type":"system","subtype":"init","cwd":"/workspace","session_id":"abc-123","model":"claude-sonnet-5","tools":["Bash","Edit"]}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me look at the repo."}]},"session_id":"abc-123"}`,
  `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"session_id":"abc-123"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"README.md"}]},"session_id":"abc-123"}`,
  `not json, ignore me`,
  `{"type":"result","subtype":"success","is_error":false,"duration_ms":5000,"num_turns":3,"result":"Done.","session_id":"abc-123","total_cost_usd":0.0123}`,
];

test("claude-code adapter parses a full transcript", () => {
  const events = transcript
    .map((line) => claudeCodeAdapter.parseEvent(line))
    .filter((ev): ev is AgentEvent => ev !== null);

  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((e) => e.type),
    ["init", "message", "tool", "tool", "result"],
  );
  const init = events[0];
  assert.ok(init?.type === "init" && init.sessionId === "abc-123" && init.model === "claude-sonnet-5");

  const outcome = claudeCodeAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "abc-123");
  assert.equal(outcome.costUsd, 0.0123);
  assert.equal(outcome.numTurns, 3);
});

test("claude-code adapter fails on error result", () => {
  const events = [
    claudeCodeAdapter.parseEvent(
      `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","session_id":"abc"}`,
    ),
  ].filter((ev): ev is AgentEvent => ev !== null);
  const outcome = claudeCodeAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "boom");
});

test("claude-code adapter fails when stream ends without result", () => {
  const outcome = claudeCodeAdapter.extractOutcome([], 137);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /137/);
});

test("claude-code buildCommand shape", () => {
  const cmd = claudeCodeAdapter.buildCommand({
    prompt: "do the thing",
    model: "claude-sonnet-5",
    cwd: "/workspace",
    resumeSessionId: "s1",
  });
  assert.equal(cmd[0], "claude");
  assert.ok(cmd.includes("--output-format") && cmd.includes("stream-json"));
  assert.ok(cmd.includes("--include-partial-messages"), "the typing streams");
  assert.ok(cmd.includes("--resume") && cmd.includes("s1"));
});

/**
 * The stream_event lines below are verbatim from claude 2.1.221 with
 * --include-partial-messages. The field asymmetry is the API's own:
 * text_delta carries `text`, thinking_delta carries `thinking`.
 */
test("claude-code recognizes partial message fragments and consumes the chatter", () => {
  const text = claudeCodeAdapter.parseDelta?.(
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello world"}},"session_id":"s"}',
  );
  assert.deepEqual(text, { channel: "text", text: "hello world" });

  const thinking = claudeCodeAdapter.parseDelta?.(
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user is asking","estimated_tokens":null}},"session_id":"s"}',
  );
  assert.deepEqual(thinking, { channel: "thinking", text: "The user is asking" });

  // Block boundaries and signatures are streaming chatter: consumed as
  // empty fragments so they stay out of a failing run's stderr tail.
  assert.deepEqual(
    claudeCodeAdapter.parseDelta?.('{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"s"}'),
    { channel: "text", text: "" },
  );
  assert.deepEqual(
    claudeCodeAdapter.parseDelta?.(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}},"session_id":"s"}',
    ),
    { channel: "text", text: "" },
  );

  // Whole message lines belong to parseEvent, not the fragment path.
  assert.equal(
    claudeCodeAdapter.parseDelta?.('{"type":"assistant","message":{"role":"assistant","content":[]}}'),
    null,
  );
});

test("fake adapter round trips through its own parser", () => {
  const okCmd = fakeAdapter.buildCommand({ prompt: "build it", model: "fake-1", cwd: "/tmp" });
  assert.equal(okCmd[0], "sh");
  const failCmd = fakeAdapter.buildCommand({ prompt: "FAIL please", model: "fake-1", cwd: "/tmp" });
  assert.ok(failCmd[2]?.includes("exit 1"));

  const events = [
    `{"type":"system","subtype":"init","session_id":"fake-session-1","model":"fake-1"}`,
    `{"type":"result","subtype":"success","is_error":false,"session_id":"fake-session-1","total_cost_usd":0.01,"num_turns":1}`,
  ]
    .map((l) => fakeAdapter.parseEvent(l))
    .filter((ev): ev is AgentEvent => ev !== null);
  const outcome = fakeAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "fake-session-1");
});
