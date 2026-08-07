import { providerKeyFor } from "./adapter.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CREDENTIALS, type AgentEvent } from "@bento/core";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { getAdapter, runAgent } from "./index.js";

function parseAll(adapter: { parseEvent(l: string): AgentEvent | null }, lines: string[]): AgentEvent[] {
  return lines.map((l) => adapter.parseEvent(l)).filter((e): e is AgentEvent => e !== null);
}

test("codex parses a thread lifecycle", () => {
  const events = parseAll(codexAdapter, [
    `{"type":"thread.started","thread_id":"th_abc"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"type":"assistant_message","text":"Looking at the repo."}}`,
    `{"type":"item.completed","item":{"type":"command_execution","command":"ls","status":"completed"}}`,
    `{"type":"turn.completed","thread_id":"th_abc","usage":{"input_tokens":10,"output_tokens":5}}`,
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["init", "message", "tool", "result"],
  );
  const outcome = codexAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "th_abc");
});

test("codex reports turn.failed as failure", () => {
  const events = parseAll(codexAdapter, [
    `{"type":"thread.started","thread_id":"th_x"}`,
    `{"type":"turn.failed","thread_id":"th_x","error":{"message":"model overloaded"}}`,
  ]);
  const outcome = codexAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "model overloaded");
  assert.equal(outcome.sessionId, "th_x");
});

test("codex resume puts the thread id in the command", () => {
  const cmd = codexAdapter.buildCommand({
    prompt: "keep going",
    model: "gpt-5-codex",
    cwd: "/workspace",
    resumeSessionId: "th_abc",
  });
  assert.deepEqual(cmd.slice(0, 5), ["codex", "exec", "resume", "th_abc", "keep going"]);
  assert.ok(cmd.includes("--json"));
  // Must bypass approvals too: --sandbox danger-full-access alone still
  // prompts, which would hang a headless run.
  assert.ok(cmd.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!cmd.includes("--full-auto"), "--full-auto was removed from codex");
});

test("cursor parses stream-json and names tools from the wrapper key", () => {
  const events = parseAll(cursorAdapter, [
    `{"type":"system","subtype":"init","session_id":"c6b6","model":"Claude 4 Sonnet"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read the README"}]},"session_id":"c6b6"}`,
    `{"type":"tool_call","subtype":"started","call_id":"toolu_1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"c6b6"}`,
    `{"type":"tool_call","subtype":"completed","call_id":"toolu_1","tool_call":{"readToolCall":{"result":{"success":{}}}},"session_id":"c6b6"}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"Done","session_id":"c6b6"}`,
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["init", "message", "tool", "tool", "result"],
  );
  const started = events[2];
  assert.ok(started?.type === "tool" && started.name === "readToolCall" && started.phase === "start");
  const outcome = cursorAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "c6b6");
});

test("cursor trusts the result event over the exit code", () => {
  // Cursor's headless exit codes are undocumented, so a successful
  // result must not be overridden by a stray non-zero exit.
  const events = parseAll(cursorAdapter, [`{"type":"result","subtype":"success","is_error":false,"session_id":"c"}`]);
  assert.equal(cursorAdapter.extractOutcome(events, 3).ok, true);
});

test("cursor accepts chat_id as the session id", () => {
  const events = parseAll(cursorAdapter, [
    `{"type":"system","subtype":"init","chat_id":"chat_1"}`,
    `{"type":"result","is_error":false,"chat_id":"chat_1"}`,
  ]);
  assert.equal(cursorAdapter.extractOutcome(events, 0).sessionId, "chat_1");
});

test("cursor marks error results as failed", () => {
  const events = parseAll(cursorAdapter, [`{"type":"result","is_error":true,"result":"auth failed","chat_id":"c"}`]);
  const outcome = cursorAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "auth failed");
});

test("opencode parses its NDJSON envelope", () => {
  const events = parseAll(opencodeAdapter, [
    `{"type":"step_start","timestamp":1,"sessionID":"ses_9","part":{}}`,
    `{"type":"tool_use","timestamp":2,"sessionID":"ses_9","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed"}}}`,
    `{"type":"text","timestamp":3,"sessionID":"ses_9","part":{"type":"text","text":"Done. I updated the docs."}}`,
    `{"type":"step_finish","timestamp":4,"sessionID":"ses_9","part":{}}`,
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["init", "tool", "message"],
  );
  const tool = events[1];
  assert.ok(tool?.type === "tool" && tool.name === "bash");
  const outcome = opencodeAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "ses_9");
});

test("opencode has no terminal event, so the exit code decides success", () => {
  const events = parseAll(opencodeAdapter, [`{"type":"step_start","sessionID":"ses_1","part":{}}`]);
  assert.equal(opencodeAdapter.extractOutcome(events, 0).ok, true);
  assert.equal(opencodeAdapter.extractOutcome(events, 1).ok, false);
});

test("opencode surfaces an error line as failure", () => {
  const events = parseAll(opencodeAdapter, [
    `{"type":"step_start","sessionID":"ses_2","part":{}}`,
    `{"type":"error","sessionID":"ses_2","error":{"name":"ProviderAuthError","message":"missing api key"}}`,
  ]);
  const outcome = opencodeAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "missing api key");
  assert.equal(outcome.sessionId, "ses_2");
});

/**
 * opencode emits step_start before every agent loop step (each tool
 * call and the final answer), all carrying the same session id. The
 * adapter maps each to an init event, and init renders as
 * "[session started]" in the transcript, so without runAgent's
 * dedupe a 2-tool run opened the transcript with three of them.
 * claude-code, codex, cursor, and pi each emit their init line once,
 * so collapsing to the first is safe for every adapter.
 */
test("runAgent keeps only the first init across opencode step_starts", async () => {
  async function* steps(): AsyncIterable<{ kind: "stdout" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stdout", data: `{"type":"step_start","sessionID":"ses_x","part":{}}\n` };
    yield { kind: "stdout", data: `{"type":"tool_use","sessionID":"ses_x","part":{"tool":"bash","callID":"c1","state":{"status":"running"}}}\n` };
    yield { kind: "stdout", data: `{"type":"tool_use","sessionID":"ses_x","part":{"tool":"bash","callID":"c1","state":{"status":"completed"}}}\n` };
    yield { kind: "stdout", data: `{"type":"step_start","sessionID":"ses_x","part":{}}\n` };
    yield { kind: "stdout", data: `{"type":"text","sessionID":"ses_x","part":{"text":"Done."}}\n` };
    yield { kind: "stdout", data: `{"type":"step_start","sessionID":"ses_x","part":{}}\n` };
    yield { kind: "exit", exitCode: 0 };
  }
  const seen: AgentEvent[] = [];
  const { outcome } = await runAgent({
    adapter: opencodeAdapter,
    argv: ["opencode"],
    exec: steps,
    onEvent: (event) => seen.push(event),
  });
  const inits = seen.filter((e) => e.type === "init");
  assert.equal(inits.length, 1, "only the first step_start should become an init");
  assert.equal(outcome.sessionId, "ses_x");
  assert.equal(outcome.ok, true);
});

test("opencode builds a provider qualified model command", () => {
  const cmd = opencodeAdapter.buildCommand({
    prompt: "do it",
    model: "anthropic/claude-sonnet-5",
    cwd: "/workspace",
  });
  assert.ok(cmd.includes("--format") && cmd.includes("json"));
  assert.ok(cmd.includes("--auto"));
  assert.equal(cmd.at(-1), "do it");
});

test("every declared cli resolves to an adapter", () => {
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "fake"] as const) {
    assert.equal(getAdapter(cli).cli, cli);
  }
});

test("adapters declare the env they need", () => {
  assert.deepEqual(codexAdapter.requiredEnv, ["OPENAI_API_KEY"]);
  assert.deepEqual(cursorAdapter.requiredEnv, ["CURSOR_API_KEY"]);
});

/**
 * pi emits its session as NDJSON under --mode json. These lines follow
 * the documented shapes: a session header, then agent, message, and tool
 * events.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md
 */
test("pi builds a headless json-mode command", () => {
  const argv = piAdapter.buildCommand({
    prompt: "Add a dark theme",
    model: "anthropic/claude-sonnet-5",
    cwd: "/workspace",
  });
  assert.deepEqual(argv, [
    "pi",
    "--mode",
    "json",
    "--print",
    "--model",
    "anthropic/claude-sonnet-5",
    "Add a dark theme",
  ]);
  // pi is provider agnostic, so it demands no particular credential.
  assert.deepEqual(piAdapter.requiredEnv, []);
});

test("pi resumes by session id", () => {
  const argv = piAdapter.buildCommand({
    prompt: "also handle the empty case",
    model: "anthropic/claude-sonnet-5",
    cwd: "/workspace",
    resumeSessionId: "0f8c1d2e-aaaa-bbbb-cccc-1234567890ab",
  });
  assert.ok(argv.includes("--session"));
  assert.equal(argv[argv.indexOf("--session") + 1], "0f8c1d2e-aaaa-bbbb-cccc-1234567890ab");
});

test("pi parses its session header, messages, and tools", () => {
  const header = piAdapter.parseEvent(
    '{"type":"session","version":3,"id":"0f8c1d2e-aaaa","timestamp":"2026-07-27T10:00:00Z","cwd":"/workspace"}',
  );
  assert.equal(header?.type, "init");
  assert.equal(header && "sessionId" in header ? header.sessionId : undefined, "0f8c1d2e-aaaa");

  // Assistant content is a list of blocks; only text blocks are prose.
  const message = piAdapter.parseEvent(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "Adding the toggle." },
        ],
      },
    }),
  );
  assert.deepEqual(
    message && message.type === "message" ? { role: message.role, text: message.text } : null,
    { role: "assistant", text: "Adding the toggle." },
  );

  const started = piAdapter.parseEvent('{"type":"tool_execution_start","toolCallId":"1","toolName":"edit","args":{}}');
  assert.equal(started?.type === "tool" ? started.phase : null, "start");
  const ended = piAdapter.parseEvent('{"type":"tool_execution_end","toolCallId":"1","toolName":"edit","isError":false}');
  assert.equal(ended?.type === "tool" ? ended.phase : null, "end");

  // Token deltas would be one row per token, so they are dropped.
  assert.equal(piAdapter.parseEvent('{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}'), null);
  assert.equal(piAdapter.parseEvent("not json"), null);
});

test("pi sums cost across assistant messages", () => {
  // pi reports usage per message, not once at the end.
  const result = piAdapter.parseEvent(
    JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [] },
        { role: "assistant", content: [], usage: { cost: { total: 0.02 } } },
        { role: "assistant", content: [], usage: { cost: { total: 0.03 } } },
      ],
    }),
  );
  assert.equal(result?.type === "result" ? result.ok : null, true);
  assert.equal(result?.type === "result" ? result.costUsd : null, 0.05);
  assert.equal(result?.type === "result" ? result.numTurns : null, 2);
});

test("pi reports a failed run and keeps the session id for resuming", () => {
  const events = [
    piAdapter.parseEvent('{"type":"session","version":3,"id":"sess-9"}'),
    piAdapter.parseEvent(
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [], errorMessage: "context length exceeded" }],
      }),
    ),
  ].filter((e): e is NonNullable<typeof e> => e !== null);

  const outcome = piAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /context length exceeded/);
  assert.equal(outcome.sessionId, "sess-9", "a failed run is still resumable");
});

test("pi exiting without a result is a failure, not a silent success", () => {
  // Happens when a credential or model is rejected before the loop runs.
  const outcome = piAdapter.extractOutcome([], 1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /stopped before reporting a result/);
});

test("pi recognizes streaming fragments of text and thinking", () => {
  const text = piAdapter.parseDelta?.(
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hel"}}',
  );
  assert.deepEqual(text, { channel: "text", text: "Hel" });

  const thinking = piAdapter.parseDelta?.(
    '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}',
  );
  assert.deepEqual(thinking, { channel: "thinking", text: "hmm" });

  // Tool argument fragments are half a JSON object; tool events cover them.
  assert.equal(
    piAdapter.parseDelta?.(
      '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\\"pa"}}',
    ),
    null,
  );
  assert.equal(piAdapter.parseDelta?.('{"type":"message_end","message":{}}'), null);
  assert.equal(piAdapter.parseDelta?.("not json"), null);
});

/**
 * Fragments are display only: they reach onDelta and nothing else. In
 * particular they must not land in the stray output tail, where they
 * used to bury a failing run's actual reason under token JSON.
 */
test("streamed fragments reach onDelta and stay out of the transcript and the failure tail", async () => {
  const lines = [
    '{"type":"session","version":3,"id":"sess-1"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Wor"}}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"king"}}',
  ];
  async function* fails(): AsyncIterable<{ kind: "stdout" | "stderr" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stdout", data: lines.map((l) => `${l}\n`).join("") };
    yield { kind: "stderr", data: "credential rejected\n" };
    yield { kind: "exit", exitCode: 1 };
  }
  const deltas: { channel: string; text: string; offset: number }[] = [];
  const { events, outcome } = await runAgent({
    adapter: piAdapter,
    argv: ["pi"],
    exec: fails,
    onDelta: (delta) => deltas.push(delta),
  });
  assert.deepEqual(
    deltas,
    [
      { channel: "text", text: "Wor", offset: 0 },
      { channel: "text", text: "king", offset: 3 },
    ],
    "fragments carry the offset a late joiner needs to detect a torn draft",
  );
  assert.deepEqual(events.map((e) => e.type), ["init"], "fragments are not events");
  assert.match(outcome.error ?? "", /credential rejected/, "the real reason survives");
  assert.doesNotMatch(outcome.error ?? "", /message_update/, "token JSON stays out of the tail");
});

/**
 * A key an adapter reads but the catalog cannot store is unreachable in
 * multi mode: the adapter would ask for it and no one could supply it.
 * That is how Gemini support was declared by pi and storable by nobody.
 */
test("every credential an adapter can use is storable", () => {
  const storable = new Set(AGENT_CREDENTIALS.map((c) => c.name));
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "fake"] as const) {
    const adapter = getAdapter(cli);
    for (const name of [...adapter.requiredEnv, ...(adapter.optionalEnv ?? [])]) {
      assert.ok(storable.has(name), `${cli} uses ${name}, which no one can store`);
    }
  }
});

/**
 * A CLI that dies before its event stream starts leaves the reason on
 * stderr, and a bare "stopped before reporting a result" with the reason thrown
 * away is what a person actually sees. The tail rides on the error.
 * Found live: claude refuses --dangerously-skip-permissions as root,
 * said so on stderr, and every containerised run failed unexplained.
 */
test("a run that dies without events carries its stderr in the error", async () => {
  const adapter = getAdapter("claude-code");
  async function* dies(): AsyncIterable<{ kind: "stdout" | "stderr" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stderr", data: "--dangerously-skip-permissions cannot be used with root/sudo privileges\n" };
    yield { kind: "exit", exitCode: 1 };
  }
  const { outcome } = await runAgent({ adapter, argv: ["claude"], exec: dies });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /stopped before reporting a result/);
  assert.match(outcome.error ?? "", /cannot be used with root/, "the reason rides along");
});

test("an agent that explained itself in a result keeps its own error", async () => {
  const adapter = getAdapter("claude-code");
  async function* explained(): AsyncIterable<{ kind: "stdout" | "stderr" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stderr", data: "some warning noise\n" };
    yield {
      kind: "stdout",
      data: JSON.stringify({ type: "result", is_error: true, result: "Not logged in", session_id: "s1" }) + "\n",
    };
    yield { kind: "exit", exitCode: 1 };
  }
  const { outcome } = await runAgent({ adapter, argv: ["claude"], exec: explained });
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.error ?? "", /warning noise/, "stderr must not bury the agent's own answer");
});

test("provider agnostic tools require the key their model implies", () => {
  assert.deepEqual(providerKeyFor("openrouter/openai/gpt-5.6-sol"), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(providerKeyFor("anthropic/claude-sonnet-5"), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(providerKeyFor("google/gemini-3.6-flash"), ["GEMINI_API_KEY"]);
  assert.deepEqual(providerKeyFor("mystery/model"), []);
  assert.deepEqual(opencodeAdapter.requiredEnvFor?.("openrouter/x/y"), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(piAdapter.requiredEnvFor?.("openai/gpt-5"), ["OPENAI_API_KEY"]);
});
