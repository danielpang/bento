import { credentialNamesFor, forwardedEnvNames, providerKeyFor, requiredEnvForModel, runsOnOllama, writeFileCommand } from "./adapter.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CREDENTIALS, type AgentEvent } from "@bento/core";
import { antigravityAdapter } from "./antigravity.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { dshAdapter } from "./dsh.js";
import { fxAdapter } from "./fx.js";
import { museAdapter } from "./muse.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { poolAdapter } from "./pool.js";
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

/**
 * Codex 0.153 reads neither variable Bento stores. With OPENAI_API_KEY
 * set it sent api.openai.com no Authorization header, and with
 * OPENAI_BASE_URL set it still called api.openai.com. The key has to
 * arrive as CODEX_API_KEY. OpenRouter is a custom model_provider, not
 * a base URL on the reserved openai id: when OpenRouter is the
 * selected provider (a slash slug on Codex), the adapter passes
 * `-c model_provider=openrouter`, and the OpenRouter key is what that
 * provider reads.
 */
test("codex OpenRouter slugs select the OpenRouter provider and keep the key out of argv", () => {
  const input = {
    prompt: "do it",
    model: "openai/gpt-5-mini",
    cwd: "/workspace",
    extraArgs: ["-c", 'model_reasoning_effort="high"'],
    credentials: {
      OPENROUTER_API_KEY: "sk-or-routed",
      OPENAI_API_KEY: "sk-proj-leftover",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    },
  };
  const cmd = codexAdapter.buildCommand(input);
  const provider = cmd.indexOf('model_provider="openrouter"');
  assert.ok(provider > 0 && cmd[provider - 1] === "-c", "OpenRouter is selected as the model provider");
  const base = cmd.indexOf('model_providers.openrouter.base_url="https://openrouter.ai/api/v1"');
  assert.ok(base > 0 && cmd[base - 1] === "-c", "and its endpoint is set as a config override");
  assert.ok(base < cmd.indexOf('model_reasoning_effort="high"'), "before the profile's own args");
  assert.ok(!cmd.some((arg) => arg.includes("sk-or-routed")), "the key never reaches argv");
  assert.ok(!cmd.some((arg) => arg.startsWith("openai_base_url")), "OpenRouter is not the built-in openai provider");
  assert.deepEqual(codexAdapter.requiredEnvFor?.("openai/gpt-5-mini"), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(requiredEnvForModel(codexAdapter, "openai/gpt-5-mini"), ["OPENROUTER_API_KEY"]);
  assert.equal(forwardedEnvNames(codexAdapter, "openai/gpt-5-mini").includes("OPENAI_API_KEY"), false);
  assert.deepEqual(codexAdapter.env?.(input), {});
  const resumed = codexAdapter.buildCommand({ ...input, resumeSessionId: "th_abc" });
  assert.ok(resumed.includes('model_provider="openrouter"'));
});

test("codex without an OpenRouter slug keeps OpenAI's own endpoint", () => {
  const input = { prompt: "do it", model: "gpt-5-codex", cwd: "/workspace", credentials: { OPENAI_API_KEY: "sk-proj" } };
  assert.ok(!codexAdapter.buildCommand(input).some((arg) => arg.includes("model_provider")));
  assert.ok(!codexAdapter.buildCommand(input).some((arg) => arg.startsWith("openai_base_url")));
  assert.deepEqual(codexAdapter.env?.(input), { CODEX_API_KEY: "sk-proj" });
  assert.deepEqual(codexAdapter.requiredEnvFor?.("gpt-5-codex"), ["OPENAI_API_KEY"]);
  assert.deepEqual(codexAdapter.env?.({ ...input, credentials: {} }), {});
});

test("codex selects OpenRouter as model_provider for a slash slug the catalog has not listed", () => {
  const cmd = codexAdapter.buildCommand({
    prompt: "do it",
    model: "openai/gpt-brand-new",
    cwd: "/workspace",
  });
  assert.ok(cmd.includes('model_provider="openrouter"'));
  assert.deepEqual(codexAdapter.requiredEnvFor?.("openai/gpt-brand-new"), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(codexAdapter.requiredEnvFor?.("acme/unreleased"), ["OPENROUTER_API_KEY"]);
});

test("codex vercel/ slugs select the Gateway provider and strip the prefix", () => {
  const input = {
    prompt: "do it",
    model: "vercel/moonshotai/kimi-k3",
    cwd: "/workspace",
    credentials: { AI_GATEWAY_API_KEY: "vck_routed", OPENAI_API_KEY: "sk-proj-leftover" },
  };
  const cmd = codexAdapter.buildCommand(input);
  assert.ok(cmd.includes("-m"));
  assert.equal(cmd[cmd.indexOf("-m") + 1], "moonshotai/kimi-k3");
  assert.ok(cmd.includes('model_provider="vercel"'));
  assert.ok(cmd.includes('model_providers.vercel.base_url="https://ai-gateway.vercel.sh/codex/v1"'));
  assert.ok(cmd.includes('model_providers.vercel.env_key="AI_GATEWAY_API_KEY"'));
  assert.ok(!cmd.includes('model_provider="openrouter"'));
  assert.deepEqual(codexAdapter.requiredEnvFor?.("vercel/moonshotai/kimi-k3"), ["AI_GATEWAY_API_KEY"]);
  assert.deepEqual(codexAdapter.requiredEnvFor?.("vercel/acme/unreleased"), ["AI_GATEWAY_API_KEY"]);
  assert.deepEqual(codexAdapter.env?.(input), {});
});

test("codex sends a saved non-OpenRouter base URL as openai_base_url", () => {
  const cmd = codexAdapter.buildCommand({
    prompt: "do it",
    model: "gpt-5-codex",
    cwd: "/workspace",
    credentials: { OPENAI_API_KEY: "sk-proj", OPENAI_BASE_URL: "https://gateway.example/v1" },
  });
  const override = cmd.indexOf('openai_base_url="https://gateway.example/v1"');
  assert.ok(override > 0 && cmd[override - 1] === "-c");
  assert.ok(!cmd.includes('model_provider="openrouter"'));
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

test("cursor bounds its final background shell wait without limiting the active turn", () => {
  const argv = cursorAdapter.buildCommand({ cwd: "/workspace", model: "auto", prompt: "Build it" });
  assert.equal(argv[argv.indexOf("--background-shell-timeout") + 1], "30");
  assert.ok(!argv.includes("--single-turn"), "background completions still get their follow-up turns");
  const notice = cursorAdapter.parseEvent(JSON.stringify({
    type: "system", subtype: "background_shell_timeout", aborted_count: 1, timeout_ms: 30000,
  }));
  assert.ok(notice?.type === "message" && notice.role === "system");
});

test("cursor thinking is live output, never a successful result or raw JSON in an error", async () => {
  const deltas: unknown[] = [];
  const result = await runAgent({
    adapter: cursorAdapter,
    argv: ["cursor-agent"],
    exec: async function* () {
      yield { kind: "stdout", data: '{"type":"thinking","subtype":"delta","text":"Already committed."}\n' };
      yield { kind: "stdout", data: '{"type":"thinking","subtype":"completed"}\n' };
      yield { kind: "stderr", data: "exec timeout: the command reached its 7200 second limit" };
      yield { kind: "exit", exitCode: -1 };
    },
    onDelta: (delta) => { deltas.push(delta); },
  });
  assert.deepEqual(deltas, [{ channel: "thinking", text: "Already committed.", offset: 0 }]);
  assert.equal(result.outcome.ok, false);
  assert.match(result.outcome.error!, /exec timeout/);
  assert.doesNotMatch(result.outcome.error!, /thinking|Already committed|subtype/);
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
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "pool", "dsh", "antigravity", "muse", "fx", "fake"] as const) {
    assert.equal(getAdapter(cli).cli, cli);
  }
});

test("adapters declare the env they need", () => {
  assert.deepEqual(codexAdapter.requiredEnv, ["OPENAI_API_KEY"]);
  assert.deepEqual(codexAdapter.requiredEnvFor?.("gpt-5-codex"), ["OPENAI_API_KEY"]);
  assert.deepEqual(codexAdapter.requiredEnvFor?.("openai/gpt-5-mini"), ["OPENROUTER_API_KEY"]);
  // The OpenRouter key is selected per model, not forwarded on every
  // Codex run: a native OpenAI sandbox must not receive it.
  assert.equal((codexAdapter.optionalEnv ?? []).includes("OPENROUTER_API_KEY"), false);
  assert.deepEqual(cursorAdapter.requiredEnv, ["CURSOR_API_KEY"]);
  assert.deepEqual(poolAdapter.requiredEnv, ["POOLSIDE_API_KEY"]);
  assert.deepEqual(dshAdapter.requiredEnv, ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(antigravityAdapter.requiredEnv, ["GEMINI_API_KEY"]);
  assert.deepEqual(museAdapter.requiredEnv, ["META_API_KEY"]);
  assert.deepEqual(fxAdapter.requiredEnv, ["AI_GATEWAY_API_KEY"]);
});

test("dsh builds its headless command and isolated environment", () => {
  const input = {
    prompt: "Implement the card",
    model: "deepseek-v4-pro",
    cwd: "/workspace",
  };
  assert.deepEqual(dshAdapter.buildCommand(input), ["dsh", "--profile", "headless", "Implement the card"]);
  assert.deepEqual(dshAdapter.optionalEnv, ["DEEPSEEK_BASE_URL"]);
  assert.deepEqual(dshAdapter.env?.(input), {
    DSH_MODEL: "deepseek-v4-pro",
    DSH_TOOLS_MODE: "native",
    DSH_PERMISSION_MODE: "danger-full-access",
    DSH_TELEMETRY_DISABLED: "1",
  });
  assert.equal(dshAdapter.env?.(input).DSH_HOME, undefined);
  assert.equal(dshAdapter.stdoutMode, "text");
});

test("runAgent collects dsh stdout into one final assistant message", async () => {
  async function* output(): AsyncIterable<{ kind: "stdout" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stdout", data: "Implemented " };
    yield { kind: "stdout", data: "the card.\n" };
    yield { kind: "exit", exitCode: 0 };
  }
  const seen: AgentEvent[] = [];
  const result = await runAgent({
    adapter: dshAdapter,
    argv: ["dsh"],
    exec: output,
    onEvent: (event) => seen.push(event),
  });
  assert.deepEqual(result.events, [{ type: "message", role: "assistant", text: "Implemented the card." }]);
  assert.deepEqual(seen, result.events);
  assert.equal(result.outcome.ok, true);
});

test("runAgent emits no dsh message for empty output", async () => {
  async function* empty(): AsyncIterable<{ kind: "stdout" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stdout", data: "\n  " };
    yield { kind: "exit", exitCode: 0 };
  }
  const result = await runAgent({ adapter: dshAdapter, argv: ["dsh"], exec: empty });
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.outcome, { ok: false, error: "dsh finished without readable output" });
});

test("runAgent bounds dsh stdout at 256 KiB and retains its head and tail", async () => {
  async function* large(): AsyncIterable<{ kind: "stdout" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stdout", data: "A".repeat(200_000) };
    yield { kind: "stdout", data: "Z".repeat(200_000) };
    yield { kind: "exit", exitCode: 0 };
  }
  const result = await runAgent({ adapter: dshAdapter, argv: ["dsh"], exec: large });
  const event = result.events[0];
  assert.ok(event?.type === "message");
  assert.equal(event.text.length, 256 * 1024);
  assert.ok(event.text.startsWith("AAAA"));
  assert.ok(event.text.endsWith("ZZZZ"));
  assert.match(event.text, /stdout truncated/);
});

test("dsh failures retain stderr details", async () => {
  async function* fails(): AsyncIterable<{ kind: "stderr" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stderr", data: "DeepSeek rejected the API key\n" };
    yield { kind: "exit", exitCode: 1 };
  }
  const result = await runAgent({ adapter: dshAdapter, argv: ["dsh"], exec: fails });
  assert.equal(result.outcome.ok, false);
  assert.match(result.outcome.error ?? "", /dsh stopped before reporting a result/);
  assert.match(result.outcome.error ?? "", /DeepSeek rejected the API key/);
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

test("pi rewrites a vercel/ slug to its vercel-ai-gateway provider", () => {
  const argv = piAdapter.buildCommand({
    prompt: "Add a dark theme",
    model: "vercel/moonshotai/kimi-k3",
    cwd: "/workspace",
  });
  assert.deepEqual(argv, [
    "pi",
    "--mode",
    "json",
    "--print",
    "--provider",
    "vercel-ai-gateway",
    "--model",
    "moonshotai/kimi-k3",
    "Add a dark theme",
  ]);
  assert.deepEqual(piAdapter.requiredEnvFor?.("vercel/moonshotai/kimi-k3"), ["AI_GATEWAY_API_KEY"]);
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

  // Tool argument fragments are half a JSON object; tool events cover
  // them. Consumed as empty chatter rather than left for the tail.
  assert.deepEqual(
    piAdapter.parseDelta?.(
      '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\\"pa"}}',
    ),
    { channel: "text", text: "" },
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
  const sampleModels = ["gpt-5-codex", "openai/gpt-5-mini", "openrouter/auto", "anthropic/claude-sonnet-5"];
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "pool", "dsh", "antigravity", "muse", "fx", "fake"] as const) {
    const adapter = getAdapter(cli);
    const names = new Set([
      ...adapter.requiredEnv,
      ...(adapter.optionalEnv ?? []),
      ...sampleModels.flatMap((model) => adapter.requiredEnvFor?.(model) ?? []),
    ]);
    for (const name of names) {
      // Poolside's enterprise endpoint is a local environment override.
      // Hosted v1 always targets Platform and deliberately offers no
      // organization setting for a custom endpoint.
      if (cli === "pool" && name === "POOLSIDE_STANDALONE_BASE_URL") continue;
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

/**
 * A result event that carried no error text explained nothing. Seen
 * live: claude-code's error_during_execution results have no `result`
 * field, so runs failed as "no reason reported" while the reason sat
 * on stderr.
 */
test("a reasonless error result still carries the stderr tail", async () => {
  const adapter = getAdapter("claude-code");
  async function* reasonless(): AsyncIterable<{ kind: "stdout" | "stderr" | "exit"; data?: string; exitCode?: number }> {
    yield { kind: "stderr", data: "API Error: 429 rate limited\n" };
    yield {
      kind: "stdout",
      data: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" }) + "\n",
    };
    yield { kind: "exit", exitCode: 1 };
  }
  const { outcome } = await runAgent({ adapter, argv: ["claude"], exec: reasonless });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /error during execution/);
  assert.match(outcome.error ?? "", /rate limited/, "the reason rides along");
});

test("provider agnostic tools require the key their model implies", () => {
  assert.deepEqual(providerKeyFor("openrouter/openai/gpt-5.6-sol"), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(providerKeyFor("vercel/moonshotai/kimi-k3"), ["AI_GATEWAY_API_KEY"]);
  assert.deepEqual(providerKeyFor("anthropic/claude-sonnet-5"), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(providerKeyFor("google/gemini-3.6-flash"), ["GEMINI_API_KEY"]);
  assert.deepEqual(providerKeyFor("deepseek/deepseek-v4-pro"), ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(providerKeyFor("mystery/model"), []);
  assert.deepEqual(opencodeAdapter.requiredEnvFor?.("openrouter/x/y"), ["OPENROUTER_API_KEY"]);
  assert.deepEqual(piAdapter.requiredEnvFor?.("openai/gpt-5"), ["OPENAI_API_KEY"]);
});

/**
 * Every pool assertion below is written against output captured from
 * pool 1.0.16 itself, run against Poolside-hosted inference and against
 * a local OpenAI-compatible endpoint. The docs describe a `thought`
 * event as the agent's message text; the CLI actually says
 * `assistantMessage` for what the reader is told and keeps `thought`
 * for the turn's thinking, which is why the mapping below looks
 * different from the documented list.
 */
test("pool builds a headless exec command", () => {
  const argv = poolAdapter.buildCommand({
    prompt: "Add a dark theme",
    model: "poolside/laguna-s-2.1",
    cwd: "/workspace/app",
  });
  assert.deepEqual(argv, [
    "pool",
    "exec",
    "-o",
    "json",
    "--unsafe-auto-allow",
    "--sandbox",
    "disabled",
    "-d",
    "/workspace/app",
    "-p",
    "Add a dark theme",
  ]);
  // argv[0] stays the binary: the "not installed" failure and the
  // spawn-failure check both read it.
  assert.equal(argv[0], "pool");
  // No --model flag exists, so nothing may claim to pass one.
  assert.ok(!argv.includes("--model"));
});

test("pool takes its model and endpoint as environment, not flags", () => {
  const env = poolAdapter.env!({
    prompt: "go",
    model: "poolside/laguna-s-2.1",
    cwd: "/workspace",
  });
  assert.deepEqual(env, {
    POOLSIDE_STANDALONE_BASE_URL: "https://inference.poolside.ai/v1",
    POOLSIDE_STANDALONE_MODEL: "poolside/laguna-s-2.1",
  });
  // Local runners can override the endpoint through their environment.
  // Hosted v1 always uses the Platform default above.
  assert.deepEqual(poolAdapter.optionalEnv, ["POOLSIDE_STANDALONE_BASE_URL"]);
});

test("pool resumes by run id, attached to the flag", () => {
  const argv = poolAdapter.buildCommand({
    prompt: "keep going",
    model: "poolside/laguna-s-2.1",
    cwd: "/workspace",
    resumeSessionId: "01a02a49-33d8-7cba-aaec-4536bf2f7d66",
  });
  // Attached with =, because --continue is valid alone ("the last run
  // in this sandbox") and a detached value would be read as the prompt.
  assert.ok(argv.includes("--continue=01a02a49-33d8-7cba-aaec-4536bf2f7d66"));
  assert.equal(argv.at(-2), "-p");
});

test("pool parses the records its json mode actually prints", () => {
  const events = parseAll(poolAdapter, [
    `{"message":"Let me look at the directory.","type":"assistantMessage"}`,
    `{"args":{"cmd":"ls -1"},"name":"shell","type":"toolCall"}`,
    `{"result":"exited with code 0","type":"toolCallResult"}`,
    `{"thought":"The listing is enough to answer.","type":"thought"}`,
    `{"args":{"success":true},"name":"exit","type":"toolCall"}`,
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["message", "tool", "tool", "message", "tool"],
  );
  const said = events[0];
  assert.ok(said?.type === "message" && said.role === "assistant");
  const call = events[1];
  assert.ok(call?.type === "tool" && call.name === "shell" && call.phase === "start");
  // The result record names no tool, so nothing pretends to know which
  // call it closes.
  const done = events[2];
  assert.ok(done?.type === "tool" && done.phase === "end");
  // Thinking is the agent's, not the reader's, so it is not the
  // agent's voice in the transcript.
  const thought = events[3];
  assert.ok(thought?.type === "message" && thought.role === "system");
  assert.equal(poolAdapter.extractOutcome(events, 0).ok, true);
  // Nothing prints a run id, so none is invented: a session id here
  // would make the next run resume a conversation pool cannot find.
  assert.equal(poolAdapter.extractOutcome(events, 0).sessionId, undefined);
});

test("pool's reasoning records are consumed rather than streamed", () => {
  // They arrive whole and the thought record repeats them, so there is
  // nothing to forward. Consumed anyway, so a failing run's tail holds
  // the reason instead of a page of reasoning JSON.
  assert.deepEqual(poolAdapter.parseDelta!(`{"reasoning":"The user wants a listing.","type":"reasoning"}`), {
    channel: "thinking",
    text: "",
  });
  assert.equal(poolAdapter.parseDelta!(`{"message":"Done.","type":"assistantMessage"}`), null);
  assert.equal(poolAdapter.parseDelta!("not json"), null);
});

test("pool's fatal record is a failure with the endpoint's own words", () => {
  // Captured verbatim: a revoked Poolside Platform key.
  const events = parseAll(poolAdapter, [
    `{"error":"403 Forbidden: please check the api-key you provided: encountered unexpected error"}`,
  ]);
  const outcome = poolAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /check the api-key you provided/);
});

test("pool reports the last fatal record", () => {
  const events = parseAll(poolAdapter, [
    `{"error":"first failure"}`,
    `{"error":"final failure"}`,
  ]);
  assert.equal(poolAdapter.extractOutcome(events, 1).error, "final failure");
});

test("pool wants no browser login in a sandbox", () => {
  const event = poolAdapter.parseEvent(`{"type":"oauth_url","url":"https://platform.poolside.ai/oauth"}`);
  assert.ok(event?.type === "result" && event.ok === false);
  assert.match(event.error ?? "", /browser login, which a sandbox cannot do/);
});

/**
 * pool documents its exit codes and honours them: 0 done, 4 the agent
 * saying it could not do the task, anything else unexpected. So unlike
 * Cursor the code is authoritative, and unlike opencode there is no
 * terminal event to prefer over it.
 */
test("pool's exit code decides, and 4 is the agent giving up rather than a crash", () => {
  assert.equal(poolAdapter.extractOutcome([], 0).ok, true);
  const gaveUp = poolAdapter.extractOutcome([], 4);
  assert.equal(gaveUp.ok, false);
  assert.match(gaveUp.error ?? "", /reported the task as not completed/);
  const died = poolAdapter.extractOutcome([], 1);
  assert.equal(died.ok, false);
  assert.match(died.error ?? "", /stopped before reporting a result/);
});

/**
 * Antigravity's stream is an envelope: every line names its `event` and
 * carries the payload under a key of the same name. The lifecycle here
 * is the one a run produces, in order.
 */
test("antigravity parses a headless conversation", () => {
  const lines = [
    `{"event":"init","conversation_id":"c3b66b04","init":{"cwd":"/workspace","model":"gemini-3.1-pro-high","permission_mode":"always-proceed","tools":["run_command"]}}`,
    `{"event":"step_update","step_update":{"conversation_id":"c3b66b04","step_index":1,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"run_command","parameters":{"command":"ls"}}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"c3b66b04","step_index":1,"state":"DONE","step_type":"tool","tool_info":{"name":"run_command","output":"README.md"}}}`,
    `{"event":"step_update","step_update":{"conversation_id":"c3b66b04","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Read the "}}`,
    `{"event":"step_update","step_update":{"conversation_id":"c3b66b04","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Read the readme."}}`,
    `{"event":"result","result":{"conversation_id":"c3b66b04","status":"SUCCESS","response":"Read the readme.","num_turns":2,"duration_seconds":9}}`,
  ];
  const events = parseAll(antigravityAdapter, lines);
  assert.deepEqual(
    events.map((e) => e.type),
    ["init", "tool", "tool", "message", "result"],
    "the ACTIVE fragment of a response is a delta, not a transcript event",
  );
  assert.deepEqual(
    events.filter((e) => e.type === "tool").map((e) => [e.name, e.phase]),
    [
      ["run_command", "start"],
      ["run_command", "end"],
    ],
  );
  const outcome = antigravityAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "c3b66b04");
  assert.equal(outcome.numTurns, 2);
});

/**
 * A response streams as fragments of one step and lands once. Without
 * the delta path they would each become a transcript message, and the
 * card would read the answer out four times.
 */
test("antigravity streams a response as deltas and keeps one message", () => {
  const active = `{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Rebasing "}}`;
  assert.deepEqual(antigravityAdapter.parseDelta?.(active), { channel: "text", text: "Rebasing " });
  assert.equal(antigravityAdapter.parseEvent(active), null);

  const done = `{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Rebasing rewrites history."}}`;
  assert.equal(antigravityAdapter.parseDelta?.(done), null, "the finished text is the message, not a delta");
  assert.deepEqual(antigravityAdapter.parseEvent(done)?.type, "message");

  // A tool step is never mistaken for typing.
  const tool = `{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"tool","tool_info":{"name":"edit_file"}}}`;
  assert.equal(antigravityAdapter.parseDelta?.(tool), null);
});

test("antigravity reports a failed result with its own reason", () => {
  const events = parseAll(antigravityAdapter, [
    `{"event":"init","conversation_id":"c9"}`,
    `{"event":"result","result":{"conversation_id":"c9","status":"ERROR","error":{"type":"quota","message":"model quota exhausted"}}}`,
  ]);
  const outcome = antigravityAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "model quota exhausted");
  // Kept even on a failure: it is the conversation a retry resumes.
  assert.equal(outcome.sessionId, "c9");
});

/**
 * agy exits 42 on a bad argument and 53 on the turn limit, and neither
 * necessarily contradicts the terminal event. The exit code decides.
 */
test("antigravity trusts a non-zero exit over a successful result", () => {
  const events = parseAll(antigravityAdapter, [
    `{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"done"}}`,
  ]);
  const outcome = antigravityAdapter.extractOutcome(events, 53);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /exit code 53/);
});

test("antigravity builds its headless command and resumes by conversation", () => {
  const input = { prompt: "Implement the card", model: "gemini-3.1-pro-high", cwd: "/workspace" };
  const cmd = antigravityAdapter.buildCommand(input);
  // The prompt is -p's value and has to stay beside it: agy rejects a
  // valueless prompt flag rather than reading the next flag as one.
  assert.deepEqual(cmd.slice(0, 3), ["agy", "-p", "Implement the card"]);
  assert.ok(cmd.includes("--output-format") && cmd.includes("stream-json"));
  assert.ok(cmd.includes("--dangerously-skip-permissions"));
  assert.deepEqual(cmd.slice(-2), ["--model", "gemini-3.1-pro-high"]);
  assert.ok(!cmd.includes("--conversation"));

  const resumed = antigravityAdapter.buildCommand({ ...input, resumeSessionId: "c3b66b04" });
  assert.deepEqual(resumed.slice(-2), ["--conversation", "c3b66b04"]);
  assert.deepEqual(antigravityAdapter.optionalEnv, ["GOOGLE_GEMINI_BASE_URL"]);
});

test("antigravity writes its MCP servers where agy reads them", () => {
  const files = antigravityAdapter.mcp!.renderConfig([
    { slug: "linear", url: "https://bento.test/mcp/linear", transport: "http", headers: { Authorization: "Bearer t" } },
  ]);
  assert.deepEqual(files.map((f) => f.path), ["/root/.gemini/config/mcp_config.json"]);
  assert.deepEqual(JSON.parse(files[0]!.content), {
    mcpServers: {
      linear: { serverUrl: "https://bento.test/mcp/linear", headers: { Authorization: "Bearer t" } },
    },
  });
  // Called with nothing attached too, so a removed server does not
  // linger in a sandbox the next run reuses.
  assert.deepEqual(JSON.parse(antigravityAdapter.mcp!.renderConfig([])[0]!.content), { mcpServers: {} });
});

/**
 * Muse Code's stream is an envelope: every line names its `payload_type`
 * and carries the body under `payload`. The lifecycle here is the one
 * a run produces, captured from `muse exec --json --yolo --provider echo`.
 */
function museLine(
  payloadType: string,
  payload: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema_version: 1,
    stream: { kind: "session", id: "11111111-1111-4111-8111-111111111111" },
    payload_type: payloadType,
    payload,
    ...extra,
  });
}

test("muse parses a headless conversation", () => {
  const events = parseAll(museAdapter, [
    museLine("runtime.command.accepted"),
    museLine("run.lifecycle.started"),
    museLine("task.lifecycle.proposed", { task_kind: "tool.bash" }),
    museLine("tool.result", { text: "README.md" }, { correlation_facts: { tool_name: "bash" } }),
    museLine("run.output.delta", { text: "Read the " }),
    museLine("run.terminal.completed", { text: "Read the readme." }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["init", "init", "tool", "tool", "message"],
    "output deltas are not transcript events",
  );
  assert.deepEqual(
    events.filter((e) => e.type === "tool").map((e) => [e.name, e.phase]),
    [
      ["bash", "start"],
      ["bash", "end"],
    ],
  );
  const said = events.find((e) => e.type === "message");
  assert.ok(said?.type === "message" && said.text === "Read the readme.");
  const outcome = museAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "11111111-1111-4111-8111-111111111111");
});

test("muse streams a response as deltas and keeps one message", () => {
  const delta = museLine("run.output.delta", { text: "Rebasing " });
  assert.deepEqual(museAdapter.parseDelta?.(delta), { channel: "text", text: "Rebasing " });
  assert.equal(museAdapter.parseEvent(delta), null);

  const done = museLine("run.terminal.completed", { text: "Rebased onto main." });
  assert.equal(museAdapter.parseDelta?.(done), null, "the finished text is the message, not a delta");
  assert.deepEqual(museAdapter.parseEvent(done)?.type, "message");
});

test("muse ignores reminder and unknown-model task proposals", () => {
  assert.equal(museAdapter.parseEvent(museLine("task.lifecycle.proposed", { task_kind: "reminder.agent.idle" })), null);
  assert.equal(
    museAdapter.parseEvent(museLine("task.lifecycle.proposed", { task_kind: "model.unknown.response" })),
    null,
  );
});

test("muse reports a failed terminal with its own reason", () => {
  const events = parseAll(museAdapter, [
    museLine("runtime.command.accepted"),
    museLine("run.terminal.failed", { reason: "invalid API key" }),
  ]);
  const outcome = museAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "invalid API key");
  assert.equal(outcome.sessionId, "11111111-1111-4111-8111-111111111111");
});

test("muse trusts a non-zero exit over a completed terminal", () => {
  const events = parseAll(museAdapter, [museLine("run.terminal.completed", { text: "Done." })]);
  const outcome = museAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /exit code 1/);
});

test("muse builds its headless command and resumes by session", () => {
  const input = { prompt: "Implement the card", model: "muse-spark-1.3", cwd: "/workspace" };
  const cmd = museAdapter.buildCommand(input);
  assert.deepEqual(cmd, [
    "muse",
    "exec",
    "--json",
    "--yolo",
    "--user-input-auto-resolve",
    "--workspace",
    "/workspace",
    "--model",
    "muse-spark-1.3",
    "Implement the card",
  ]);
  const resumed = museAdapter.buildCommand({ ...input, resumeSessionId: "11111111-1111-4111-8111-111111111111" });
  assert.ok(resumed.includes("--session-id"));
  assert.equal(resumed[resumed.indexOf("--session-id") + 1], "11111111-1111-4111-8111-111111111111");
  assert.equal(resumed.at(-1), "Implement the card");
});

test("muse writes its MCP servers where the CLI reads them", () => {
  const files = museAdapter.mcp!.renderConfig([
    { slug: "linear", url: "https://bento.test/mcp/linear", transport: "http", headers: { Authorization: "Bearer t" } },
  ]);
  assert.deepEqual(files.map((f) => f.path), ["/root/.config/muse/settings.json"]);
  assert.deepEqual(JSON.parse(files[0]!.content), {
    schema_version: 1,
    mcp_servers: {
      linear: {
        transport: "streamable_http",
        url: "https://bento.test/mcp/linear",
        headers: { Authorization: "Bearer t" },
        enabled: true,
        mode: "optional",
      },
    },
  });
  assert.deepEqual(JSON.parse(museAdapter.mcp!.renderConfig([])[0]!.content), {
    schema_version: 1,
    mcp_servers: {},
  });
});

const OLLAMA = { OLLAMA_API_KEY: "ollama-secret", OLLAMA_BASE_URL: "http://gpu-box:11434/v1" };

/**
 * An Anthropic key or a Claude subscription token forwarded to an Ollama
 * run would be sent to whatever server OLLAMA_BASE_URL names, so an
 * ollama/ model is given Ollama's credentials and no shared login.
 */
test("an Ollama run is given Ollama's credentials and no shared login", () => {
  for (const adapter of [claudeCodeAdapter, dshAdapter]) {
    const names = credentialNamesFor(adapter, "ollama/glm-5.1");
    assert.deepEqual(names, {
      required: [],
      optional: ["OLLAMA_API_KEY", "OLLAMA_BASE_URL"],
      alternatives: [],
      ollama: "always",
    });
    // With nothing saved it is still Ollama's, and the run stops naming the key.
    assert.equal(runsOnOllama(names, {}), true);
  }
  assert.deepEqual(credentialNamesFor(claudeCodeAdapter, "claude-sonnet-5"), {
    required: ["ANTHROPIC_API_KEY"],
    optional: ["ANTHROPIC_BASE_URL"],
    alternatives: ["CLAUDE_CODE_OAUTH_TOKEN"],
    ollama: "never",
  });
});

/**
 * "ollama" is also a provider opencode's own config can define. Bento's
 * Ollama takes the model over only once Ollama credentials are saved;
 * until then the run is opencode's, with opencode's credentials.
 */
test("opencode keeps its own ollama provider until Ollama credentials are saved", () => {
  const names = credentialNamesFor(opencodeAdapter, "ollama/qwen3:8b");
  assert.equal(names.ollama, "when-saved");
  assert.deepEqual(names.optional, [...(opencodeAdapter.optionalEnv ?? []), "OLLAMA_API_KEY", "OLLAMA_BASE_URL"]);
  assert.equal(runsOnOllama(names, { ANTHROPIC_API_KEY: "sk-ant" }), false);
  assert.equal(runsOnOllama(names, { OLLAMA_BASE_URL: "http://gpu-box:11434" }), true);
  const input = { prompt: "do it", model: "ollama/qwen3:8b", cwd: "/workspace" };
  assert.deepEqual(opencodeAdapter.env?.({ ...input, credentials: { ANTHROPIC_API_KEY: "sk-ant" } }), {});
  assert.deepEqual(opencodeAdapter.env?.(input), {});
});

test("Claude Code on an Ollama model talks to Ollama and nothing of Anthropic's", () => {
  const input = { prompt: "do it", model: "ollama/glm-5.1", cwd: "/workspace", credentials: OLLAMA };
  const cmd = claudeCodeAdapter.buildCommand(input);
  assert.equal(cmd[cmd.indexOf("--model") + 1], "glm-5.1");
  assert.ok(!cmd.some((arg) => arg.includes("ollama-secret")), "the key never reaches argv");
  const live = claudeCodeAdapter.live!.buildCommand(input);
  assert.equal(live[live.indexOf("--model") + 1], "glm-5.1");
  // Anthropic's credentials are overwritten, not left out: the local
  // process driver would otherwise inherit the server's own.
  assert.deepEqual(claudeCodeAdapter.env?.(input), {
    ANTHROPIC_BASE_URL: "http://gpu-box:11434",
    ANTHROPIC_AUTH_TOKEN: "ollama-secret",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
    CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.1",
  });
  assert.equal(
    claudeCodeAdapter.env?.({ ...input, credentials: { OLLAMA_API_KEY: "k" } }).ANTHROPIC_BASE_URL,
    "https://ollama.com",
    "no saved base URL is Ollama Cloud",
  );
  assert.deepEqual(claudeCodeAdapter.env?.({ ...input, model: "claude-sonnet-5" }), {});
});

test("opencode on an Ollama model brings its own provider config", () => {
  const input = { prompt: "do it", model: "ollama/gpt-oss:120b", cwd: "/workspace", credentials: OLLAMA };
  const cmd = opencodeAdapter.buildCommand(input);
  assert.equal(cmd[cmd.indexOf("-m") + 1], "ollama/gpt-oss:120b");
  const config = opencodeAdapter.env?.(input).OPENCODE_CONFIG_CONTENT ?? "";
  assert.ok(!config.includes("ollama-secret"), "the key is referenced, not inlined");
  assert.deepEqual(JSON.parse(config).provider.ollama, {
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama",
    options: { baseURL: "http://gpu-box:11434/v1", apiKey: "{env:OLLAMA_API_KEY}" },
    models: { "gpt-oss:120b": { name: "gpt-oss:120b" } },
  });
  const keyless = opencodeAdapter.env?.({ ...input, credentials: { OLLAMA_BASE_URL: "http://gpu-box:11434" } });
  assert.equal(JSON.parse(keyless?.OPENCODE_CONFIG_CONTENT ?? "{}").provider.ollama.options.apiKey, undefined);
  assert.deepEqual(opencodeAdapter.env?.({ ...input, model: "anthropic/claude-sonnet-5" }), {});
});

test("opencode on a vercel/ model points its built-in Gateway provider at the stored key", () => {
  const input = {
    prompt: "do it",
    model: "vercel/moonshotai/kimi-k3",
    cwd: "/workspace",
    credentials: { AI_GATEWAY_API_KEY: "vck_routed" },
  };
  const config = opencodeAdapter.env?.(input).OPENCODE_CONFIG_CONTENT ?? "";
  assert.ok(!config.includes("vck_routed"), "the key is referenced, not inlined");
  assert.deepEqual(JSON.parse(config).provider.vercel, {
    options: { apiKey: "{env:AI_GATEWAY_API_KEY}" },
  });
  assert.deepEqual(opencodeAdapter.env?.({ ...input, credentials: {} }), {});
  assert.deepEqual(opencodeAdapter.requiredEnvFor?.("vercel/moonshotai/kimi-k3"), ["AI_GATEWAY_API_KEY"]);
});

test("DeepSeek Harness on an Ollama model points its provider at Ollama with a lower token limit", () => {
  const input = { prompt: "do it", model: "ollama/gpt-oss:120b", cwd: "/workspace", credentials: OLLAMA };
  const files = dshAdapter.files?.(input) ?? [];
  assert.equal(files.length, 1);
  assert.match(files[0]!.content, /- id: llm-deepseek\n  config:\n    maxTokens: 32768/);
  assert.deepEqual(dshAdapter.buildCommand(input), ["dsh", "--profile", "headless", "--patch", files[0]!.path, "do it"]);
  assert.deepEqual(dshAdapter.env?.(input), {
    DSH_MODEL: "gpt-oss:120b",
    DSH_TOOLS_MODE: "native",
    DSH_PERMISSION_MODE: "danger-full-access",
    DSH_TELEMETRY_DISABLED: "1",
    DEEPSEEK_BASE_URL: "http://gpu-box:11434/v1",
    DEEPSEEK_API_KEY: "ollama-secret",
  });
  assert.deepEqual(dshAdapter.files?.({ ...input, model: "deepseek-v4-pro" }), []);
});

test("writeFileCommand writes content a shell would otherwise mangle", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/bento-write-`);
  const file = { path: `${dir}/nested/it's here.yml`, content: "- id: x\n  quote: 'single' \"double\" $HOME `tick`\n" };
  const [command, ...args] = writeFileCommand(file);
  await new Promise<void>((resolve, reject) => execFile(command!, args, (err) => (err ? reject(err) : resolve())));
  assert.equal(await readFile(file.path, "utf8"), file.content);
});

/**
 * pi reaches no Ollama of Bento's, so an ollama/ model there is pi's own
 * provider (from its models.json) and keeps pi's credentials and login.
 */
test("an ollama/ model on a tool Bento does not point at Ollama keeps that tool's credentials", () => {
  const names = credentialNamesFor(piAdapter, "ollama/gpt-oss:20b");
  assert.equal(names.ollama, "never");
  assert.equal(runsOnOllama(names, { OLLAMA_API_KEY: "k" }), false);
  assert.deepEqual(names.optional, piAdapter.optionalEnv);
  assert.ok(!names.optional.includes("OLLAMA_API_KEY"));
});

/**
 * Captured from `fx ask --json --full-access` on fx 0.0.9: one compact
 * object on stdout, even when the request fails before a model is
 * chosen. Progress and the human-readable reason stay on stderr.
 */
function fxAsk(fields: Record<string, unknown>): string {
  return JSON.stringify({
    output: "",
    final_output: "",
    exit_code: 0,
    model: "moonshotai/kimi-k3",
    session_id: "ses_1",
    steps: 1,
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens: 4 },
    ...fields,
  });
}

test("fx parses a successful ask document", () => {
  const events = parseAll(fxAdapter, [
    fxAsk({
      output: "Read the readme.\n\nDone.",
      final_output: "Done.",
      tool_calls: [{ name: "read_file", status: "success" }],
    }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "message");
  assert.ok(events[0]?.type === "message" && events[0].text === "Done.");
  const outcome = fxAdapter.extractOutcome(events, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.sessionId, "ses_1");
  assert.equal(outcome.numTurns, 1);
});

test("fx prefers final_output and falls back to output", () => {
  assert.equal(fxAdapter.parseEvent(fxAsk({ final_output: "", output: "Working notes." }))?.type, "message");
  const fallback = fxAdapter.parseEvent(fxAsk({ final_output: "", output: "Working notes." }));
  assert.ok(fallback?.type === "message" && fallback.text === "Working notes.");
});

test("fx reports MissingCredentials as a failed result", () => {
  const events = parseAll(fxAdapter, [
    fxAsk({
      exit_code: 1,
      model: "",
      session_id: "",
      steps: 0,
      error: "MissingCredentials",
      usage: { input_tokens: null, output_tokens: null },
    }),
  ]);
  const outcome = fxAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "MissingCredentials");
  assert.equal(outcome.sessionId, undefined);
});

test("fx trusts a non-zero exit over a successful document", () => {
  const events = parseAll(fxAdapter, [fxAsk({ final_output: "Done." })]);
  const outcome = fxAdapter.extractOutcome(events, 1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /exit code 1/);
  assert.equal(outcome.sessionId, "ses_1");
});

test("fx builds its headless command and resumes by session", () => {
  const input = { prompt: "Implement the card", model: "moonshotai/kimi-k3", cwd: "/workspace" };
  const cmd = fxAdapter.buildCommand(input);
  assert.deepEqual(cmd, ["fx", "ask", "--json", "--full-access", "--no-color", "--", "Implement the card"]);
  assert.deepEqual(fxAdapter.env?.(input), {
    FX_MODEL: "moonshotai/kimi-k3",
    FX_PERMISSION_MODE: "full-access",
    FX_AUTO_UPGRADE: "0",
    FX_NO_OPEN_BROWSER: "1",
  });
  const resumed = fxAdapter.buildCommand({ ...input, resumeSessionId: "ses_1" });
  assert.deepEqual(resumed, [
    "fx",
    "ask",
    "--json",
    "--full-access",
    "--no-color",
    "--resume",
    "ses_1",
    "--",
    "Implement the card",
  ]);
});

test("fx writes its MCP servers where the CLI reads them", () => {
  const files = fxAdapter.mcp!.renderConfig([
    { slug: "docs", url: "https://bento.test/mcp", transport: "http", headers: { Authorization: "Bearer t" } },
  ]);
  assert.deepEqual(files.map((f) => f.path), ["/root/.fx/mcp.json"]);
  assert.deepEqual(JSON.parse(files[0]!.content), {
    mcp: {
      docs: {
        type: "http",
        url: "https://bento.test/mcp",
        bearer_token_env: "BENTO_MCP_GRANT",
        enabled: true,
        required: false,
      },
    },
  });
  assert.doesNotMatch(files[0]!.content, /Authorization/);
  assert.deepEqual(fxAdapter.mcp!.env?.([
    { slug: "docs", url: "https://bento.test/mcp", transport: "http", headers: { Authorization: "Bearer t" } },
  ]), { BENTO_MCP_GRANT: "t" });
  assert.deepEqual(JSON.parse(fxAdapter.mcp!.renderConfig([])[0]!.content), { mcp: {} });
  assert.deepEqual(fxAdapter.mcp!.env?.([]), {});
});
