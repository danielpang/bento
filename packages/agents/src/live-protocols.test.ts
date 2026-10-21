import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@bento/core";
import type { BuildCommandInput, LiveProtocol } from "./adapter.js";
import { codexAdapter } from "./codex.js";
import { opencodeAdapter } from "./opencode.js";
import { runAgent } from "./execute.js";
import type { ExecChunk } from "./execute.js";

/**
 * The live protocols for Codex (`codex app-server`) and opencode
 * (`opencode acp`). The lines the "process" sends here are the shapes
 * codex-cli 0.163.0 and opencode 1.19.3 printed when driven over stdio
 * against stand-in model servers, trimmed to the fields Bento reads.
 */

const input: BuildCommandInput = { prompt: "Do the task", model: "gpt-5-codex", cwd: "/workspace/app" };
const json = (line: string) => JSON.parse(line) as Record<string, unknown> & { id?: string; method?: string; params?: Record<string, unknown> };

/** Answers the request a line made, the way the server would. */
function answer(request: string, result: unknown, jsonrpc = false): string {
  return JSON.stringify({ ...(jsonrpc ? { jsonrpc: "2.0" } : {}), id: json(request).id, result });
}
function refuse(request: string, message: string, code = -32600): string {
  return JSON.stringify({ id: json(request).id, error: { code, message } });
}
const note = (method: string, params: unknown, jsonrpc = false) => JSON.stringify({ ...(jsonrpc ? { jsonrpc: "2.0" } : {}), method, params });

function codex(over: Partial<BuildCommandInput> = {}, attach = false): LiveProtocol {
  return codexAdapter.live!.connect!({ ...input, ...over }, { attach });
}

test("codex: the handshake goes out at once, and the prompt waits for the thread it must name", () => {
  const p = codex();
  const lines = p.open("Do the task");
  assert.deepEqual(lines.map((l) => json(l).method), ["initialize", "initialized", "thread/start"]);
  const start = json(lines[2]!);
  assert.deepEqual(start.params, { cwd: "/workspace/app", model: "gpt-5-codex", approvalPolicy: "never", sandbox: "danger-full-access" });
  assert.equal("jsonrpc" in start, false, "codex's app-server omits the jsonrpc member");
  assert.equal(p.held, 1, "the prompt is held until the thread id is known");

  const reply = p.read(answer(lines[2]!, { thread: { id: "thr-1" }, model: "gpt-5-codex" }));
  assert.equal(p.held, 0);
  assert.equal(reply.write.length, 1);
  const turn = json(reply.write[0]!);
  assert.equal(turn.method, "turn/start");
  assert.deepEqual(turn.params, { threadId: "thr-1", input: [{ type: "text", text: "Do the task", text_elements: [] }] });
  assert.deepEqual(reply.events?.map((e) => e.type), ["init"]);
  assert.equal((reply.events?.[0] as Extract<AgentEvent, { type: "init" }>).sessionId, "thr-1");
});

test("codex: a message mid-turn is another turn/start, which the server folds into the running turn", () => {
  const p = codex();
  const [, , start] = p.open("first");
  p.read(answer(start!, { thread: { id: "thr-1" } }));
  const lines = p.send("steer this way");
  assert.equal(lines?.length, 1);
  assert.equal(json(lines![0]!).method, "turn/start", "turn/start steers an active turn; turn/steer would need its id");
});

test("codex: a turn's usage is the sum of its calls' `last` counts, and another turn's report is not counted", () => {
  const p = codex();
  const [, , start] = p.open("go");
  p.read(answer(start!, { thread: { id: "thr-1" } }));
  // What a resume replays first: the previous turn's usage.
  assert.deepEqual(p.read(note("thread/tokenUsage/updated", { threadId: "thr-1", turnId: "old", tokenUsage: { total: { inputTokens: 15, outputTokens: 5 }, last: { inputTokens: 15, outputTokens: 5 } } })).events, []);
  p.read(note("thread/tokenUsage/updated", { threadId: "thr-1", turnId: "t2", tokenUsage: { total: { inputTokens: 26, outputTokens: 8 }, last: { inputTokens: 11, outputTokens: 3 } } }));
  p.read(note("thread/tokenUsage/updated", { threadId: "thr-1", turnId: "t2", tokenUsage: { total: { inputTokens: 39, outputTokens: 13 }, last: { inputTokens: 13, outputTokens: 5 } } }));
  const end = p.read(note("turn/completed", { threadId: "thr-1", turn: { id: "t2", status: "completed", error: null } })).events;
  assert.deepEqual(end, [{
    type: "result",
    ok: true,
    sessionId: "thr-1",
    inputTokens: 24,
    outputTokens: 8,
    raw: { threadId: "thr-1", turn: { id: "t2", status: "completed", error: null } },
  }]);
});

test("codex: a failed or interrupted turn is a failure with Codex's reason", () => {
  const p = codex();
  const failed = p.read(note("turn/completed", { threadId: "thr-1", turn: { id: "t1", status: "failed", error: { message: "rate limited" } } })).events?.[0];
  assert.equal(failed?.type === "result" && failed.ok, false);
  assert.equal(failed?.type === "result" ? failed.error : undefined, "rate limited");
  const interrupted = p.read(note("turn/completed", { threadId: "thr-1", turn: { id: "t2", status: "interrupted", error: null } })).events?.[0];
  assert.equal(interrupted?.type === "result" ? interrupted.error : undefined, "Codex interrupted the turn");
});

test("codex: every request from the server is answered, because it waits for the answer", () => {
  const p = codex();
  const approve = json(p.read(JSON.stringify({ id: 7, method: "item/commandExecution/requestApproval", params: {} })).write[0]!);
  assert.deepEqual(approve, { id: 7, result: { decision: "acceptForSession" } });
  const question = json(p.read(JSON.stringify({ id: 8, method: "item/tool/requestUserInput", params: {} })).write[0]!);
  assert.deepEqual(question, { id: 8, result: { answers: {} } });
  const unknown = json(p.read(JSON.stringify({ id: 9, method: "attestation/generate", params: {} })).write[0]!);
  assert.equal((unknown.error as { code: number }).code, -32601);
});

test("codex: a resume names the thread, and a thread the sandbox lost reads as a lost conversation", () => {
  const p = codex({ resumeSessionId: "thr-old" });
  const lines = p.open("continue");
  const resume = json(lines[2]!);
  assert.equal(resume.method, "thread/resume");
  assert.equal((resume.params as { threadId: string }).threadId, "thr-old");
  const failed = p.read(refuse(lines[2]!, "no rollout found for thread id thr-old")).events?.[0];
  assert.equal(failed?.type, "result");
  assert.match(failed?.type === "result" ? failed.error ?? "" : "", /^No conversation found with session ID: thr-old/,
    "the wording the executor's fresh restart already matches");
  assert.equal(p.held, 0, "a failed handshake holds nothing");
  assert.equal(p.send("one more"), null, "and takes nothing more: the message goes back on the card");
});

test("codex: a reattach skips the handshake and addresses the recorded thread at once", () => {
  const p = codex({ resumeSessionId: "thr-live" }, true);
  assert.deepEqual(p.open(null), []);
  const lines = p.send("are you there?");
  assert.equal((json(lines![0]!).params as { threadId: string }).threadId, "thr-live");
  assert.equal(codex({}, true).send("nobody to address"), null, "without a recorded thread there is no one to talk to");
});

test("codex: an answer to a request this connection never sent is ignored", () => {
  const p = codex();
  p.open("go");
  const stray = p.read(JSON.stringify({ id: "bento-earlier-life-3", result: { thread: { id: "thr-x" } } }));
  assert.deepEqual(stray, { write: [], events: [] });
  assert.equal(p.held, 1, "the prompt still waits for this connection's own answer");
});

test("codex: the live command is app-server with the model, and a saved key reaches it through the environment", () => {
  const live = codexAdapter.live!;
  const argv = live.buildCommand({ ...input, credentials: { OPENAI_API_KEY: "sk-test" } });
  assert.deepEqual(argv.slice(0, 4), ["codex", "app-server", "-c", 'model="gpt-5-codex"']);
  assert.ok(argv.includes('model_providers.bento-openai.env_key="CODEX_API_KEY"'));
  assert.ok(!argv.join(" ").includes("sk-test"), "the key itself never reaches argv");
  assert.deepEqual(codexAdapter.env!({ ...input, credentials: { OPENAI_API_KEY: "sk-test" } }), { CODEX_API_KEY: "sk-test" });
  const shared = live.buildCommand(input);
  assert.ok(!shared.some((a) => a.includes("bento-openai")), "no saved key: the built-in provider and its login");
  assert.equal(live.appliesTo!({ ...input, extraArgs: ["-c", 'model_reasoning_effort="high"'] }), true);
  assert.equal(live.appliesTo!({ ...input, extraArgs: ["--search"] }), false, "an exec-only flag keeps codex exec");
  assert.equal(live.beta, true);
  assert.equal(live.delivery, "steer");
});

test("codex: a live run through runAgent, from handshake to a priced result", async () => {
  const p = codex();
  const stdin: string[] = [...p.open("Do the task")];
  const out = [
    answer(stdin[0]!, { userAgent: "codex" }),
    answer(stdin[2]!, { thread: { id: "thr-9" } }),
    note("thread/started", { thread: { id: "thr-9" } }),
    note("turn/started", { threadId: "thr-9", turn: { id: "t1", status: "inProgress" } }),
    note("item/started", { threadId: "thr-9", turnId: "t1", item: { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'npm test'", status: "inProgress" } }),
    note("item/completed", { threadId: "thr-9", turnId: "t1", item: { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'npm test'", status: "completed" } }),
    note("item/agentMessage/delta", { threadId: "thr-9", turnId: "t1", itemId: "m1", delta: "All " }),
    note("item/agentMessage/delta", { threadId: "thr-9", turnId: "t1", itemId: "m1", delta: "green." }),
    note("item/completed", { threadId: "thr-9", turnId: "t1", item: { type: "agentMessage", id: "m1", text: "All green." } }),
    note("thread/tokenUsage/updated", { threadId: "thr-9", turnId: "t1", tokenUsage: { total: { inputTokens: 30, outputTokens: 9 }, last: { inputTokens: 30, outputTokens: 9 } } }),
    note("turn/completed", { threadId: "thr-9", turn: { id: "t1", status: "completed", error: null } }),
  ];
  const deltas: string[] = [];
  const result = await runAgent({
    adapter: codexAdapter,
    argv: [],
    exec: () => chunks([...out.map((l) => `${l}\n`)], 0),
    onDelta: (d) => deltas.push(d.text),
    readLine: (line) => {
      const { write, events } = p.read(line);
      stdin.push(...write);
      return events;
    },
  });
  assert.equal(json(stdin[3]!).method, "turn/start", "the prompt went out once the thread was known");
  assert.deepEqual(deltas, ["All ", "green."]);
  assert.deepEqual(result.events.map((e) => (e.type === "tool" ? `tool:${e.phase}` : e.type)), ["init", "tool:start", "tool:end", "message", "result"]);
  assert.deepEqual(result.outcome, { ok: true, sessionId: "thr-9", inputTokens: 30, outputTokens: 9 });
});

function opencode(over: Partial<BuildCommandInput> = {}, attach = false): LiveProtocol {
  return opencodeAdapter.live!.connect!({ ...input, model: "anthropic/claude-sonnet-5", ...over }, { attach });
}

/** Walks an opencode protocol through its handshake; returns what the prompts wrote. */
function readyOpencode(p: LiveProtocol, prompt: string | null = "Do the task"): string[] {
  const [init] = p.open(prompt);
  assert.equal(json(init!).method, "initialize");
  const [session] = p.read(answer(init!, { protocolVersion: 1 }, true)).write;
  const created = p.read(answer(session!, { sessionId: "ses_1", configOptions: [] }, true));
  assert.deepEqual(created.events?.map((e) => e.type), ["init"]);
  const [model] = created.write;
  return p.read(answer(model!, { configOptions: [] }, true)).write;
}

test("opencode: initialize, a session, then the model over the protocol, then the prompt", () => {
  const p = opencode();
  const [init] = p.open("Do the task");
  assert.equal(json(init!).jsonrpc, "2.0");
  assert.equal(p.held, 1);
  const [session] = p.read(answer(init!, { protocolVersion: 1 }, true)).write;
  assert.equal(json(session!).method, "session/new");
  assert.deepEqual(json(session!).params, { cwd: "/workspace/app", mcpServers: [] });
  const [model] = p.read(answer(session!, { sessionId: "ses_1" }, true)).write;
  assert.deepEqual(json(model!).params, { sessionId: "ses_1", configId: "model", value: "anthropic/claude-sonnet-5" },
    "opencode acp takes no -m, so the model is a session option");
  const [prompt] = p.read(answer(model!, { configOptions: [] }, true)).write;
  assert.equal(json(prompt!).method, "session/prompt");
  assert.deepEqual(json(prompt!).params, { sessionId: "ses_1", prompt: [{ type: "text", text: "Do the task" }] });
  assert.equal(p.held, 0);
});

test("opencode: fragments become one message per opencode message, tools close the draft, the answer ends the turn", () => {
  const p = opencode();
  const [prompt] = readyOpencode(p);
  const chunk = (messageId: string, text: string) => note("session/update", { sessionId: "ses_1", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } }, true);
  const events: AgentEvent[] = [];
  const take = (line: string) => events.push(...(p.read(line).events ?? []));
  take(chunk("msg_a", "Let me "));
  take(chunk("msg_a", "check."));
  take(note("session/update", { sessionId: "ses_1", update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "execute", status: "pending", rawInput: {} } }, true));
  take(note("session/update", { sessionId: "ses_1", update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress", title: "echo ok", rawInput: { command: "echo ok" } } }, true));
  take(note("session/update", { sessionId: "ses_1", update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", title: "echo ok", rawInput: { command: "echo ok" } } }, true));
  take(chunk("msg_b", "Done."));
  take(answer(prompt!, { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }, true));
  assert.deepEqual(events.map((e) => (e.type === "message" ? `message:${e.text}` : e.type === "tool" ? `tool:${e.phase}:${e.name}` : e.type)), [
    "message:Let me check.",
    "tool:start:bash",
    "tool:end:echo ok",
    "message:Done.",
    "result",
  ]);
  const end = events.at(-1);
  assert.deepEqual(end?.type === "result" ? [end.ok, end.sessionId, end.inputTokens, end.outputTokens] : [], [true, "ses_1", 7, 3]);
});

test("opencode: a prompt sent mid-turn is queued by opencode, and the turn ends when both are answered", () => {
  const p = opencode();
  const [first] = readyOpencode(p);
  const [second] = p.send("also this")!;
  assert.equal(json(second!).method, "session/prompt");
  assert.deepEqual(p.read(answer(first!, { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1 } }, true)).events, [],
    "one prompt still outstanding: not the end of the turn");
  const end = p.read(answer(second!, { stopReason: "end_turn", usage: { inputTokens: 6, outputTokens: 2 } }, true)).events;
  assert.deepEqual(end?.map((e) => e.type), ["result"]);
  assert.deepEqual(end?.[0]?.type === "result" ? [end[0].inputTokens, end[0].outputTokens] : [], [11, 3]);
});

test("opencode: a stop that is not the end of the turn is a failure, and a model it lacks fails the run", () => {
  const p = opencode();
  const [prompt] = readyOpencode(p);
  const end = p.read(answer(prompt!, { stopReason: "max_tokens" }, true)).events?.[0];
  assert.equal(end?.type === "result" && end.ok, false);
  assert.match(end?.type === "result" ? end.error ?? "" : "", /output limit/);

  const q = opencode({ model: "nope/missing" });
  const [init] = q.open("go");
  const [session] = q.read(answer(init!, {}, true)).write;
  const [model] = q.read(answer(session!, { sessionId: "ses_2" }, true)).write;
  const failed = q.read(refuse(model!, "Invalid params")).events?.at(-1);
  assert.match(failed?.type === "result" ? failed.error ?? "" : "", /cannot use model nope\/missing/);
  assert.equal(q.send("more"), null);
});

test("opencode: a permission request is answered with the option that allows, the way run --auto does", () => {
  const p = opencode();
  const reply = json(p.read(JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "session/request_permission",
    params: { options: [{ optionId: "once", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }] },
  })).write[0]!);
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 4, result: { outcome: { outcome: "selected", optionId: "always" } } });
});

test("opencode: a resume and a reattach both address the recorded session", () => {
  const p = opencode({ resumeSessionId: "ses_old" });
  const [init] = p.open("again");
  const [resume] = p.read(answer(init!, {}, true)).write;
  assert.equal(json(resume!).method, "session/resume");
  assert.equal((json(resume!).params as { sessionId: string }).sessionId, "ses_old");

  const attached = opencode({ resumeSessionId: "ses_live" }, true);
  assert.deepEqual(attached.open(null), []);
  assert.equal((json(attached.send("hi")![0]!).params as { sessionId: string }).sessionId, "ses_live");
});

test("opencode: a live message and the same message read back from the session record match by message id", () => {
  const recovery = opencodeAdapter.sessionRecovery!;
  const p = opencode();
  const [prompt] = readyOpencode(p);
  p.read(note("session/update", { sessionId: "ses_1", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_a", content: { type: "text", text: "Hello" } } }, true));
  const live = p.read(answer(prompt!, { stopReason: "end_turn" }, true)).events?.[0];
  assert.ok(live);
  assert.deepEqual(recovery.persistedIds(live), ["msg_a"]);

  const exported = JSON.stringify({ messages: [
    { info: { role: "assistant", id: "msg_a" }, parts: [{ type: "text", id: "prt_1", messageID: "msg_a", text: "Hello" }] },
    { info: { role: "assistant", id: "msg_b" }, parts: [
      { type: "text", id: "prt_2", messageID: "msg_b", text: "One" },
      { type: "text", id: "prt_3", messageID: "msg_b", text: "Two" },
    ] },
  ] });
  const recovered = recovery.parseLog(exported);
  const ids = recovered.map((m) => recovery.persistedIds({ type: "message", role: "assistant", text: m.text, raw: m.raw }));
  assert.deepEqual(ids, [["msg_a"], ["prt_2", "msg_b"], ["prt_3", "msg_b"]],
    "one part: the message id is exact; several: each part keeps its own");
});

test("opencode: live mode only without profile arguments written for opencode run", () => {
  const live = opencodeAdapter.live!;
  assert.equal(live.appliesTo!({ ...input }), true);
  assert.equal(live.appliesTo!({ ...input, extraArgs: ["--agent", "plan"] }), false);
  assert.deepEqual(live.buildCommand(input), ["opencode", "acp", "--print-logs", "--cwd", "/workspace/app"]);
  assert.equal(live.delivery, "queue");
});

async function* chunks(lines: string[], exitCode: number): AsyncIterable<ExecChunk> {
  for (const data of lines) yield { kind: "stdout", data };
  yield { kind: "exit", exitCode };
}
