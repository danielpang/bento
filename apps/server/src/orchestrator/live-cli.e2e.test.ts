import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@bento/core";
import { claudeCodeAdapter, codexAdapter, openLiveWire, opencodeAdapter, runAgent, type AgentAdapter, type BuildCommandInput } from "@bento/agents";
import { LineChannel, LocalProcessDriver } from "@bento/sandbox";
import { attachLiveConversation, type LiveConversation } from "./live-session.js";

/**
 * The live sessions for Codex (`codex app-server`) and opencode
 * (`opencode acp`), driven end to end through the pieces a server run
 * uses: the local-process driver's stdin, the LineChannel, the live
 * conversation that delivers a message mid-turn and closes stdin after,
 * the adapter's protocol, and runAgent. Only the model is a stand-in, an
 * HTTP server on loopback, so a run costs nothing and says what the CLI
 * actually sent it.
 *
 * The real CLIs have to be on PATH, so this is off by default:
 *
 *   BENTO_LIVE_CLI_E2E=1 node --test --import tsx src/orchestrator/live-cli.e2e.test.ts
 *
 * Verified with codex-cli 0.163.0, opencode 1.19.3 and Claude Code 2.1.306.
 */
const skip = process.env.BENTO_LIVE_CLI_E2E ? false : "set BENTO_LIVE_CLI_E2E=1 with codex, opencode and claude on PATH";

interface ModelLog {
  /** What each model call's user messages said, oldest first. */
  calls: string[][];
}

/** A model call that answers with a shell call the first time a conversation asks for it, then with text. */
function standInModel(kind: "responses" | "chat", log: ModelLog, firstCallMs: number): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || "{}") as { input?: unknown[]; messages?: unknown[] };
    const items = (kind === "responses" ? request.input : request.messages) ?? [];
    const users = items
      .filter((item): item is { role: string; content: unknown } => (item as { role?: string }).role === "user")
      .map((item) => (typeof item.content === "string" ? item.content : JSON.stringify(item.content)));
    // opencode titles its session with a side call; it is not the turn.
    if (users.some((text) => text.includes("Generate a title"))) return reply(res, kind, { text: "A title" });
    log.calls.push(users);
    const toolResults = items.filter((item) => {
      const it = item as { type?: string; role?: string };
      return it.type === "function_call_output" || it.role === "tool";
    }).length;
    const asked = users.filter((text) => text.includes("USE_TOOL")).length;
    if (log.calls.length === 1) await new Promise((r) => setTimeout(r, firstCallMs));
    if (toolResults < asked) return reply(res, kind, { tool: true, n: log.calls.length });
    const last = users.at(-1) ?? "";
    return reply(res, kind, { text: `answer ${log.calls.length}, last said: ${last.includes("STEER") ? "STEER" : last.slice(-40)}` });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })),
  );
}

function reply(res: import("node:http").ServerResponse, kind: "responses" | "chat", what: { text?: string; tool?: boolean; n?: number }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (kind === "responses") {
    const ev = (o: Record<string, unknown>) => res.write(`event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`);
    const id = `resp_${Math.random().toString(36).slice(2)}`;
    ev({ type: "response.created", response: { id } });
    if (what.tool) {
      ev({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: `fc_${what.n}`, call_id: `call_${what.n}`, name: "exec_command", arguments: JSON.stringify({ cmd: "echo tool-ran" }) } });
    } else {
      ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: `${id}_m`, content: [] } });
      ev({ type: "response.output_text.delta", item_id: `${id}_m`, output_index: 0, content_index: 0, delta: what.text });
      ev({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", id: `${id}_m`, content: [{ type: "output_text", text: what.text }] } });
    }
    ev({ type: "response.completed", response: { id, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 4, output_tokens_details: null, total_tokens: 14 } } });
  } else {
    const chunk = (delta: unknown, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (what.tool) {
      chunk({ role: "assistant", content: "Checking. " });
      chunk({ tool_calls: [{ index: 0, id: `call_${what.n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo tool-ran", description: "Echo" }) } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: what.text });
      chunk({}, "stop");
    }
    res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

/** A conversation that holds nothing: stdin closes once a turn ends with nothing parked. */
function closingConversation(): LiveConversation {
  return { claim: async () => [], markSent: async () => {}, requeue: async () => {}, holdFor: async () => 0, waitingNotice: () => "" };
}

/**
 * One live run: the prompt goes in, `followUp` is delivered as soon as
 * the model has been asked once (mid-turn), and the run ends when the
 * conversation closes stdin after the turn.
 */
async function liveRun(adapter: AgentAdapter, input: BuildCommandInput, env: Record<string, string>, log: ModelLog, followUp?: string) {
  const live = adapter.live!;
  assert.equal(live.appliesTo?.(input) ?? true, true, "this run qualifies for live mode");
  const driver = new LocalProcessDriver();
  const handle = await driver.provision({ workspaceKey: "e2e", hostWorkspacePath: input.cwd } as never);
  const channel = new LineChannel();
  const wire = openLiveWire(live, input, { attach: false });
  for (const line of wire.open(input.prompt)) channel.write(line);
  const transcript: string[] = [];
  const conversation = attachLiveConversation({
    runId: "e2e",
    wire,
    liveChannel: channel,
    conversation: closingConversation(),
    sayAsUser: async (text) => {
      transcript.push(`user: ${text}`);
    },
    saySystem: async () => {},
  });
  const before = log.calls.length;
  const steer = followUp
    ? (async () => {
        while (log.calls.length === before) await new Promise((r) => setTimeout(r, 50));
        assert.equal(await conversation.deliver(followUp), true, "the follow-up went into the running process");
      })()
    : Promise.resolve();
  const result = await runAgent({
    adapter,
    argv: live.buildCommand(input),
    exec: () => driver.exec(handle, live.buildCommand(input), { cwd: input.cwd, env, stdin: channel, timeoutMs: 120_000 }),
    readLine: (line) => {
      const { write, events } = wire.read(line);
      for (const reply of write) channel.write(reply);
      return events;
    },
    onEvent: async (event) => {
      if (event.type === "result") await conversation.onTurnFinished(event.ok);
    },
  });
  await steer;
  conversation.dispose();
  return { result, transcript };
}

const summary = (events: AgentEvent[]) =>
  events.map((e) => (e.type === "tool" ? `tool:${e.phase}` : e.type === "message" ? `message:${e.role}` : e.type));

test("codex app-server: a message mid-turn steers it, and the next run resumes the thread", { skip, timeout: 180_000 }, async () => {
  const log: ModelLog = { calls: [] };
  const { server, url } = await standInModel("responses", log, 2_000);
  try {
    const cwd = mkdtempSync(join(tmpdir(), "bento-codex-live-"));
    const home = join(cwd, ".codex-home");
    mkdirSync(home);
    const env = { CODEX_HOME: home, FAKE_KEY: "k" };
    const extraArgs = [
      "-c", 'model_provider="fake"',
      "-c", 'model_providers.fake.name="fake"',
      "-c", `model_providers.fake.base_url="${url}"`,
      "-c", 'model_providers.fake.wire_api="responses"',
      "-c", 'model_providers.fake.env_key="FAKE_KEY"',
    ];
    const first = await liveRun(codexAdapter, { prompt: "USE_TOOL then report", model: "gpt-5-codex", cwd, extraArgs }, env, log, "STEER: also say hello");

    assert.equal(first.result.exitCode, 0, "closing stdin ended the process cleanly");
    assert.equal(first.result.outcome.ok, true, first.result.outcome.error);
    const events = summary(first.result.events);
    assert.deepEqual(events.slice(0, 1), ["init"]);
    assert.ok(events.includes("tool:start") && events.includes("tool:end"), `the shell call is in the transcript: ${events.join(",")}`);
    const results = first.result.events.filter((e) => e.type === "result");
    assert.equal(results.length, 1, "the steer joined the running turn rather than starting another");
    const said = first.result.events.filter((e) => e.type === "message" && e.role === "assistant").map((e) => (e as { text: string }).text);
    assert.ok(said.some((text) => text.includes("STEER")), `the model heard the steer within the turn: ${said.join(" | ")}`);
    assert.ok((first.result.outcome.inputTokens ?? 0) >= 20, "usage is the sum of the turn's model calls");
    const threadId = first.result.outcome.sessionId;
    assert.ok(threadId);

    const second = await liveRun(codexAdapter, { prompt: "and now?", model: "gpt-5-codex", cwd, extraArgs, resumeSessionId: threadId }, env, log);
    assert.equal(second.result.outcome.ok, true, second.result.outcome.error);
    assert.equal(second.result.outcome.sessionId, threadId, "the same thread");
    const lastCall = log.calls.at(-1)!;
    assert.ok(lastCall.some((text) => text.includes("USE_TOOL")) && lastCall.some((text) => text.includes("and now?")),
      "the resumed thread carried the first run's conversation");
  } finally {
    server.close();
  }
});

test("opencode acp: a message mid-turn is queued into the turn, and the next run resumes the session", { skip, timeout: 180_000 }, async () => {
  const log: ModelLog = { calls: [] };
  const { server, url } = await standInModel("chat", log, 2_000);
  try {
    const cwd = mkdtempSync(join(tmpdir(), "bento-opencode-live-"));
    const home = join(cwd, ".oc-home");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled",
      provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "fake", options: { baseURL: url, apiKey: "k" }, models: { m: { name: "m" } } } },
    }));
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    };
    // The model is chosen over the protocol, so this also proves that path.
    const first = await liveRun(opencodeAdapter, { prompt: "USE_TOOL then report", model: "fake/m", cwd }, env, log, "STEER: also say hello");

    assert.equal(first.result.exitCode, 0, "closing stdin ended the process cleanly");
    assert.equal(first.result.outcome.ok, true, first.result.outcome.error);
    const events = summary(first.result.events);
    assert.deepEqual(events.slice(0, 1), ["init"]);
    assert.ok(events.includes("tool:start") && events.includes("tool:end"), `the shell call is in the transcript: ${events.join(",")}`);
    assert.equal(first.result.events.filter((e) => e.type === "result").length, 1, "both prompts answered as one turn");
    const said = first.result.events.filter((e) => e.type === "message" && e.role === "assistant").map((e) => (e as { text: string }).text);
    assert.ok(said.some((text) => text.includes("STEER")), `the queued message reached the model in this run: ${said.join(" | ")}`);
    const sessionId = first.result.outcome.sessionId;
    assert.ok(sessionId?.startsWith("ses_"));

    const second = await liveRun(opencodeAdapter, { prompt: "and now?", model: "fake/m", cwd, resumeSessionId: sessionId }, env, log);
    assert.equal(second.result.outcome.ok, true, second.result.outcome.error);
    assert.equal(second.result.outcome.sessionId, sessionId, "the same session");
    const lastCall = log.calls.at(-1)!;
    assert.ok(lastCall.some((text) => text.includes("USE_TOOL")) && lastCall.some((text) => text.includes("and now?")),
      "the resumed session carried the first run's conversation");
  } finally {
    server.close();
  }
});

/**
 * Claude Code: a question answered by a person, then an interrupt that
 * keeps the session, through the same pieces a server run uses. Needs
 * the real `claude` on PATH. IS_SANDBOX is what Bento's drivers set so
 * skip-permissions runs as root in a sandbox.
 */
test("claude code: a question is answered through the store, and an interrupt keeps the session for the next message", { skip, timeout: 180_000 }, async () => {
  const calls: { users: string[]; toolResult: string | null }[] = [];
  const questions = [
    { question: "Which database should we use?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded" }] },
    { question: "Which features should ship first?", header: "Features", multiSelect: true, options: [{ label: "Search", description: "Full text" }, { label: "Export", description: "CSV" }, { label: "Sharing", description: "Links" }] },
  ];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = JSON.parse(body || "{}") as { stream?: boolean; model?: string; messages?: { role: string; content: unknown }[] };
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages") || !p.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "side", type: "message", role: "assistant", model: p.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    const texts = (p.messages ?? []).filter((m) => m.role === "user").map((m) =>
      typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((c) => c.text ?? c.type).join(" "));
    const last = [...(p.messages ?? [])].reverse().find((m) => m.role === "user" && Array.isArray(m.content));
    const result = Array.isArray(last?.content)
      ? (last!.content as { type: string; content?: unknown }[]).find((c) => c.type === "tool_result")
      : undefined;
    calls.push({ users: texts, toolResult: result ? JSON.stringify(result.content) : null });
    const lastText = texts.at(-1) ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `m${calls.length}`, type: "message", role: "assistant", model: p.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (lastText.includes("SLOW")) await new Promise((r) => setTimeout(r, 6_000));
    if (res.destroyed) return;
    const asking = lastText.includes("ASK") && !result;
    if (asking) {
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${calls.length}`, name: "AskUserQuestion", input: {} } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ questions }) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      const text = result ? `Thanks. Tool said: ${JSON.stringify(result.content).slice(0, 200)}` : `Reply to: ${lastText.slice(-80)}`;
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    }
    ev("message_stop", {});
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cwd = mkdtempSync(join(tmpdir(), "bento-claude-live-"));
    const env = {
      HOME: cwd,
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_API_KEY: "sk-e2e",
      CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      IS_SANDBOX: "1",
    };
    const input = { prompt: "ASK about the stack", model: "claude-sonnet-5", cwd, askUser: true };
    const live = claudeCodeAdapter.live!;
    const driver = new LocalProcessDriver();
    const handle = await driver.provision({ workspaceKey: "e2e", hostWorkspacePath: cwd } as never);
    const channel = new LineChannel();
    const wire = openLiveWire(live, input, { attach: false });
    for (const line of wire.open(input.prompt)) channel.write(line);

    // An in-memory stand-in for the run_questions rows.
    const stored: { id: string; ask: import("@bento/agents").LiveAsk }[] = [];
    let answered: { id: string; ask: import("@bento/agents").LiveAsk; answers: Record<string, string> }[] = [];
    const transcript: string[] = [];
    const session = attachLiveConversation({
      runId: "e2e-claude",
      wire,
      liveChannel: channel,
      conversation: {
        ...closingConversation(),
        holdAfterInterrupt: () => 30,
        interruptedNotice: () => "Interrupted.",
        questions: {
          record: async (ask) => {
            stored.push({ id: `row-${stored.length + 1}`, ask });
            return `row-${stored.length}`;
          },
          claimAnswers: async () => {
            const taken = answered;
            answered = [];
            return taken;
          },
          requeueAnswers: async () => {},
          withdraw: async () => {},
        },
      },
      mayEnd: async () => true,
      sayAsUser: async (text) => {
        transcript.push(`user: ${text}`);
      },
      saySystem: async (text) => {
        transcript.push(`system: ${text}`);
      },
    });

    let results = 0;
    let interruptedSeen = false;
    const run = runAgent({
      adapter: claudeCodeAdapter,
      argv: live.buildCommand(input),
      exec: () => driver.exec(handle, live.buildCommand(input), { cwd, env, stdin: channel, timeoutMs: 120_000 }),
      readLine: (line) => {
        const { write, events, asks, withdrawn } = wire.read(line);
        for (const reply of write) channel.write(reply);
        if (asks?.length) void session.ask(asks);
        if (withdrawn?.length) void session.withdraw(withdrawn);
        return events;
      },
      onEvent: async (event) => {
        if (event.type !== "result") return;
        results += 1;
        if (event.interrupted) interruptedSeen = true;
        if (results === 1) {
          // The question's turn is over; start a slow one to interrupt.
          assert.equal(await session.deliver("SLOW work, please"), true);
          return;
        }
        await session.onTurnFinished(event.ok, event.interrupted === true);
      },
    });

    // The question arrives; a person picks one database and two features.
    while (stored.length === 0) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(stored[0]!.ask.questions.map((q) => q.multiSelect), [false, true]);
    answered = [{ id: stored[0]!.id, ask: stored[0]!.ask, answers: { "Which database should we use?": "Postgres", "Which features should ship first?": "Search, Export" } }];
    assert.equal(await session.pump(), true, "the answer went into the waiting agent");

    // The slow turn starts; interrupt it.
    while (!calls.some((c) => c.users.at(-1)?.includes("SLOW"))) await new Promise((r) => setTimeout(r, 50));
    assert.equal(session.interrupt(), true);
    while (!interruptedSeen) await new Promise((r) => setTimeout(r, 50));
    assert.equal(session.waiting(), true, "held open after the interrupt");
    assert.equal(await session.deliver("Actually, just summarise."), true);

    const result = await run;
    assert.equal(result.exitCode, 0, "closing stdin after the last turn ended the process cleanly");
    assert.equal(result.outcome.ok, true, result.outcome.error);

    const answeredCall = calls.find((c) => c.toolResult?.includes("Postgres"));
    assert.ok(answeredCall, "the model read the person's answer");
    assert.match(answeredCall!.toolResult!, /Search, Export/, "both features, as one multiple choice answer");
    const lastCall = calls.at(-1)!;
    assert.ok(lastCall.users.some((t) => t.includes("Actually, just summarise.")), "the message after the interrupt reached the same session");
    assert.ok(lastCall.users.some((t) => t.includes("ASK about the stack")), "with the whole conversation before it");
    assert.ok(transcript.includes("system: Interrupted."));
  } finally {
    server.close();
  }
});
