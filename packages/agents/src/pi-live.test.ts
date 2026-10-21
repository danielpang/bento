import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piAdapter } from "./pi.js";
import { openLiveWire } from "./live-wire.js";
import { PI_ASK_USER_ENV, PI_ASK_USER_EXTENSION, PI_ASK_USER_PATH, PI_ASK_USER_TITLE } from "./pi-live.js";

/**
 * pi's live protocol. The lines the "process" sends here are the shapes
 * pi 0.70.1 and 0.73.1 printed in RPC mode with Bento's extension loaded,
 * driven against a stand-in Chat Completions API.
 */
const input = { prompt: "Do the task", model: "anthropic/claude-sonnet-5", cwd: "/workspace/app" };
const json = (line: string) => JSON.parse(line) as Record<string, unknown>;
const wire = () => openLiveWire(piAdapter.live!, input, { attach: false });

const questions = [
  { question: "Which database should we use?", header: "Database", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }] },
  { question: "Which features ship first?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }, { label: "Sharing" }] },
];
const dialog = (fields: Record<string, unknown>) => JSON.stringify({ type: "extension_ui_request", id: "ui-1", ...fields });

test("pi: the first message is a prompt, and every later one a prompt that steers a running turn", () => {
  const w = wire();
  assert.deepEqual(w.open("Do the task").map(json), [{ type: "prompt", message: "Do the task" }]);
  assert.deepEqual(w.open(null), [], "a reattach writes nothing first");
  // pi 0.70.1 and 0.73.1 steer a running turn with this, and start a turn
  // with it when idle; a bare steer to an idle agent starts nothing.
  assert.deepEqual(w.send("this way")?.map(json), [{ type: "prompt", message: "this way", streamingBehavior: "steer" }]);
});

test("pi: Bento's dialog becomes an ask, and the answer goes back as JSON the extension reads", () => {
  const w = wire();
  const read = w.read(dialog({ method: "input", title: PI_ASK_USER_TITLE, placeholder: JSON.stringify({ questions }) }));
  assert.deepEqual(read.write, []);
  const ask = read.asks?.[0];
  assert.ok(ask);
  assert.equal(ask.id, "ui-1");
  assert.deepEqual(ask.questions.map((q) => [q.question, q.header, q.multiSelect, q.options.map((o) => o.label)]), [
    ["Which database should we use?", "Database", false, ["Postgres", "SQLite"]],
    ["Which features ship first?", undefined, true, ["Search", "Export", "Sharing"]],
  ]);
  const answers = { "Which database should we use?": "SQLite", "Which features ship first?": "Search, Export" };
  const reply = json(w.answer!(ask, answers)[0]!);
  assert.deepEqual(reply, { type: "extension_ui_response", id: "ui-1", value: JSON.stringify({ answers }) });
  assert.deepEqual(json(w.decline!(ask, "Nobody is here.")[0]!).value, JSON.stringify({ declined: "Nobody is here." }));
});

test("pi: any other dialog is cancelled, so a project's extension never stalls the agent", () => {
  const w = wire();
  for (const method of ["select", "confirm", "editor", "input"]) {
    const read = w.read(dialog({ method, title: "Proceed?" }));
    assert.equal(read.asks, undefined);
    assert.deepEqual(json(read.write[0]!), { type: "extension_ui_response", id: "ui-1", cancelled: true }, method);
  }
  assert.deepEqual(w.read(dialog({ method: "notify", message: "hi" })), { write: [], events: [] }, "fire and forget needs nothing");
  assert.deepEqual(w.read(JSON.stringify({ type: "agent_start" })), { write: [] }, "ordinary lines are left to the parser");
  const malformed = w.read(dialog({ method: "input", title: PI_ASK_USER_TITLE, placeholder: "{}" }));
  assert.equal(JSON.parse(String(json(malformed.write[0]!).value)).declined.length > 0, true, "a question nobody can show is declined");
});

test("pi: the extension is written, and its tool turned on, only where a person can answer", () => {
  assert.deepEqual(piAdapter.files!(input), []);
  assert.deepEqual(piAdapter.env!(input), {});
  assert.deepEqual(piAdapter.files!({ ...input, askUser: true }).map((f) => f.path), [PI_ASK_USER_PATH]);
  assert.deepEqual(piAdapter.env!({ ...input, askUser: true }), { [PI_ASK_USER_ENV]: "1" });
  assert.ok(PI_ASK_USER_PATH.startsWith("~/.pi/agent/extensions/"), "pi loads it by itself: -e does not expand ~");
});

/** Loads the extension's source the way pi would, and runs its tool against a stub ctx. */
async function loadTool(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "bento-pi-ext-"));
  const file = join(dir, "ask-user.mjs");
  writeFileSync(file, PI_ASK_USER_EXTENSION);
  const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
  let tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> } | undefined;
  const before = process.env[PI_ASK_USER_ENV];
  if (enabled) process.env[PI_ASK_USER_ENV] = "1";
  else delete process.env[PI_ASK_USER_ENV];
  try {
    mod.default({ registerTool: (t: typeof tool) => (tool = t) });
  } finally {
    if (before === undefined) delete process.env[PI_ASK_USER_ENV];
    else process.env[PI_ASK_USER_ENV] = before;
  }
  return tool;
}

test("pi: a run nobody is watching gets no ask_user tool, even where the file was left", async () => {
  assert.equal(await loadTool(false), undefined);
});

test("pi: the extension asks through ctx.ui.input and turns each reply into the tool's result", async () => {
  const tool = await loadTool(true);
  assert.ok(tool);
  assert.equal(tool.name, "ask_user");
  const run = async (reply: string | undefined, hasUI = true) => {
    const seen: unknown[] = [];
    const ctx = { hasUI, ui: { input: async (...args: unknown[]) => (seen.push(args), reply) } };
    const result = await tool.execute("call_1", { questions }, undefined, undefined, ctx);
    return { text: result.content[0]!.text, seen };
  };
  const answered = await run(JSON.stringify({ answers: { "Which database should we use?": "SQLite" } }));
  assert.equal(answered.text, 'The user answered your questions: "Which database should we use?"="SQLite". Continue with these answers in mind.');
  const [title, placeholder] = answered.seen[0] as [string, string];
  assert.equal(title, PI_ASK_USER_TITLE);
  assert.deepEqual(JSON.parse(placeholder), { questions });
  assert.equal((await run(JSON.stringify({ declined: "Nobody is here." }))).text, "Nobody is here.");
  assert.equal((await run(undefined)).text, "The question was withdrawn before anyone answered.");
  assert.match((await run(undefined, false)).text, /Nobody is available/);
});

test("pi: an interrupt is an abort, sent only while a turn runs", () => {
  const w = wire();
  w.open("Do the task");
  assert.deepEqual(w.interrupt!(), [], "no agent_start yet: nothing to abort");
  assert.deepEqual(w.read(JSON.stringify({ type: "agent_start" })), { write: [] }, "left to the parser");
  assert.deepEqual(w.interrupt!().map(json), [{ type: "abort" }]);
  w.read(JSON.stringify({ type: "agent_end", messages: [] }));
  assert.deepEqual(w.interrupt!(), [], "the turn is over: an abort now would end nothing");
  // A message that only mentions the event is not the event.
  w.read(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"type":"agent_start"}' }] } }));
  assert.deepEqual(w.interrupt!(), []);
});

test("pi: a turn an abort stopped ends interrupted, and any other turn as before", () => {
  // agent_end as pi 0.73.1 printed it after an abort mid model call.
  const aborted = piAdapter.parseEvent(JSON.stringify({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "SLOW first" }] },
      { role: "assistant", content: [{ type: "text", text: "Working on it" }], stopReason: "aborted", errorMessage: "Request was aborted", usage: { cost: { total: 0.01 } } },
    ],
  }));
  assert.deepEqual(aborted?.type === "result" ? [aborted.ok, aborted.interrupted, aborted.error, aborted.costUsd] : [], [false, true, "Interrupted.", 0.01]);
  const failed = piAdapter.parseEvent(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }] }));
  assert.deepEqual(failed?.type === "result" ? [failed.ok, failed.interrupted, failed.error] : [], [false, undefined, "rate limited"]);
  const done = piAdapter.parseEvent(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] }));
  assert.deepEqual(done?.type === "result" ? [done.ok, done.interrupted] : [], [true, undefined]);
  assert.equal(piAdapter.live!.interrupts, true);
});

test("pi: a run whose interrupted turn was followed by another succeeds", () => {
  const interrupted = { type: "result" as const, ok: false, interrupted: true, error: "Interrupted." };
  const next = { type: "result" as const, ok: true };
  assert.equal(piAdapter.extractOutcome([{ type: "init", sessionId: "s" }, interrupted, next], 0).ok, true);
  assert.equal(piAdapter.extractOutcome([{ type: "init", sessionId: "s" }, interrupted], 0).ok, false, "unless nothing came after it");
});
