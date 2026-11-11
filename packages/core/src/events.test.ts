import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEvent, foldProgress, type AgentEvent } from "./events.js";

const step = (text: string): AgentEvent => ({ type: "message", role: "system", text, progress: true });
const note = (text: string): AgentEvent => ({ type: "message", role: "system", text });
const texts = (events: AgentEvent[]) => events.map((event) => (event.type === "message" ? event.text : event.type));

/**
 * A boot writes a line per step, and a console that drew each one spent
 * five rows saying what one row can: where the boot is now.
 */
test("a run of progress lines is drawn as its latest line", () => {
  const boot = [step("Starting sandbox."), step("Installing tools."), step("Preparing repositories."), step("Starting agent.")];
  assert.deepEqual(texts(foldProgress(boot.slice(0, 1))), ["Starting sandbox."]);
  assert.deepEqual(texts(foldProgress(boot.slice(0, 2))), ["Installing tools."], "the one row moved on");
  assert.deepEqual(texts(foldProgress(boot)), ["Starting agent."]);
});

/**
 * Something said between two steps is why the earlier step still
 * matters: "Starting sandbox." and then a retry is a boot that had
 * trouble starting, and folding the step away would leave the retry
 * with nothing to refer to.
 */
test("a line that is not a step keeps the step before it", () => {
  const events = [
    step("Starting sandbox."),
    note("Failed to provision sandbox, retrying."),
    step("Starting sandbox."),
    step("Installing tools."),
    step("Agent started."),
    { type: "message", role: "assistant", text: "On it." } as AgentEvent,
    { type: "result", ok: true } as AgentEvent,
  ];
  assert.deepEqual(texts(foldProgress(events)), [
    "Starting sandbox.",
    "Failed to provision sandbox, retrying.",
    "Agent started.",
    "On it.",
    "result",
  ]);
});

test("folding changes nothing in a transcript with no steps, and never the input", () => {
  const events = [note("Could not write a file."), note("Dependency setup needs attention.")];
  const before = structuredClone(events);
  assert.deepEqual(foldProgress(events), events);
  assert.deepEqual(events, before);
  assert.deepEqual(foldProgress([]), []);
});

test("the progress mark survives the event schema, and a line without it has none", () => {
  assert.equal(agentEvent.parse(step("Installing tools.")).type, "message");
  assert.deepEqual(agentEvent.parse(step("Installing tools.")), step("Installing tools."));
  assert.equal("progress" in agentEvent.parse(note("A warning.")), false);
});
