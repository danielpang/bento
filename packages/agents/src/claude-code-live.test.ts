import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter } from "./claude-code.js";
import { openLiveWire } from "./live-wire.js";

/**
 * Claude Code's live protocol. The lines the "process" sends here are
 * the shapes Claude Code 2.1.306 printed when driven over stdio against
 * a stand-in Messages API, key order included: a result line opens with
 * "duration_api_ms" and names its type near the end.
 */
const resultLine = (fields: Record<string, unknown>) =>
  JSON.stringify({ duration_api_ms: 27, stop_reason: null, session_id: "sess-1", total_cost_usd: 0.0001, ...fields, type: "result", uuid: "u-1" });

const input = { prompt: "Do the task", model: "claude-sonnet-5", cwd: "/workspace/app" };
const json = (line: string) => JSON.parse(line) as Record<string, unknown>;
const wire = () => openLiveWire(claudeCodeAdapter.live!, input, { attach: false });

const askLine = JSON.stringify({
  type: "control_request",
  request_id: "req-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    display_name: "AskUserQuestion",
    input: {
      questions: [
        { question: "Which database should we use?", header: "Database", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded" }], multiSelect: false },
        { question: "Which features should ship first?", header: "Features", options: [{ label: "Search", description: "Full text" }, { label: "Export", description: "CSV" }], multiSelect: true },
      ],
    },
    tool_use_id: "toolu_2",
    requires_user_interaction: true,
  },
});

test("claude: messages are one stream-json line each, the prompt first", () => {
  const w = wire();
  assert.deepEqual(w.open("Do the task").map(json), [{ type: "user", message: { role: "user", content: [{ type: "text", text: "Do the task" }] } }]);
  assert.deepEqual(w.open(null), [], "a reattach writes nothing first");
  assert.equal(json(w.send("and this")![0]!).type, "user");
});

test("claude: a question becomes an ask, and the answer echoes the request with the tool input and answers", () => {
  const w = wire();
  const read = w.read(askLine);
  assert.deepEqual(read.write, [], "nothing is answered for the person");
  assert.equal(read.asks?.length, 1);
  const asked = read.asks![0]!;
  assert.equal(asked.id, "req-1");
  assert.deepEqual(asked.questions.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)]), [
    ["Which database should we use?", false, ["Postgres", "SQLite"]],
    ["Which features should ship first?", true, ["Search", "Export"]],
  ]);
  const answers = { "Which database should we use?": "Postgres", "Which features should ship first?": "Search, Export" };
  const [reply] = w.answer!(asked, answers);
  assert.deepEqual(json(reply!), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: { behavior: "allow", updatedInput: { ...(asked.input as object), answers } },
    },
  });
  const [declined] = w.decline!(asked, "Nobody is here.");
  assert.deepEqual((json(declined!).response as { response: unknown }).response, { behavior: "deny", message: "Nobody is here." });
});

test("claude: any other tool that asks is allowed, as skip-permissions allows it", () => {
  const w = wire();
  const read = w.read(JSON.stringify({ type: "control_request", request_id: "req-2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } }));
  assert.equal(read.asks, undefined);
  assert.deepEqual((json(read.write[0]!).response as { response: unknown }).response, { behavior: "allow", updatedInput: { command: "ls" } });
  const unknown = w.read(JSON.stringify({ type: "control_request", request_id: "req-3", request: { subtype: "something_new" } }));
  assert.equal((json(unknown.write[0]!).response as { subtype: string }).subtype, "error", "answered, so the CLI never waits on it");
});

test("claude: an interrupt is a control request, and the turn it cut short ends marked interrupted", () => {
  const w = wire();
  const [request] = w.interrupt!()!;
  assert.deepEqual((json(request!) as { request: unknown }).request, { subtype: "interrupt" });
  assert.equal(json(request!).type, "control_request");
  // The CLI's own answer to the interrupt: nothing to say.
  assert.deepEqual(w.read(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "x", response: { still_queued: [] } } })), { write: [], events: [] });
  const ended = w.read(resultLine({ is_error: true, subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"] }));
  assert.deepEqual(ended.events?.map((e) => e.type === "result" && [e.ok, e.interrupted, e.sessionId, e.error]), [[false, true, "sess-1", "Interrupted."]]);
  // The next turn's end is an ordinary one again.
  assert.deepEqual(w.read(resultLine({ is_error: false, subtype: "success" })), { write: [] });
});

test("claude: a turn that finished before the interrupt reached it is read as it was", () => {
  const w = wire();
  w.interrupt!();
  assert.deepEqual(w.read(resultLine({ is_error: false, subtype: "success", result: "done" })), { write: [] });
});

test("claude: a question withdrawn by the CLI is reported by its request id", () => {
  const w = wire();
  assert.deepEqual(w.read(JSON.stringify({ type: "control_cancel_request", request_id: "req-1" })).withdrawn, ["req-1"]);
});

test("claude: a malformed question is declined rather than shown to nobody", () => {
  const w = wire();
  const read = w.read(JSON.stringify({ type: "control_request", request_id: "req-4", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ options: [] }] } } }));
  assert.equal(read.asks, undefined);
  assert.equal(((json(read.write[0]!).response as { response: { behavior: string } }).response).behavior, "deny");
});

test("claude: the question flag goes on only where a person can answer", () => {
  const live = claudeCodeAdapter.live!;
  assert.equal(live.interrupts, true);
  assert.ok(!live.buildCommand(input).includes("--permission-prompt-tool"));
  const argv = live.buildCommand({ ...input, askUser: true });
  assert.deepEqual(argv.slice(argv.indexOf("--permission-prompt-tool"), argv.indexOf("--permission-prompt-tool") + 2), ["--permission-prompt-tool", "stdio"]);
  assert.ok(argv.includes("--dangerously-skip-permissions"), "every other tool still runs without asking");
});

test("claude: ordinary stream lines are left to the adapter's parser", () => {
  const w = wire();
  assert.deepEqual(w.read(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } })), { write: [] });
  assert.deepEqual(w.read(JSON.stringify({ type: "result", subtype: "success", is_error: false })), { write: [] });
});
