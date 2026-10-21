import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@bento/core";
import { stopAction, turnRunning } from "./stop-action.js";

const prompt: AgentEvent = { type: "message", role: "user", text: "Do the task" };
const said: AgentEvent = { type: "message", role: "assistant", text: "Working on it" };
const tool: AgentEvent = { type: "tool", name: "bash", phase: "start" };
const interrupted: AgentEvent = { type: "result", ok: false, interrupted: true, error: "Interrupted." };
const notice: AgentEvent = { type: "message", role: "system", text: "If no follow up message is sent after 90s the agent run will end. Sending a follow up message will restart the stage." };
const next: AgentEvent = { type: "message", role: "user", text: "Do this instead" };

test("a turn runs from a person's message until its result", () => {
  assert.equal(turnRunning([]), true, "a run starting its first turn");
  assert.equal(turnRunning([prompt, said, tool]), true);
  assert.equal(turnRunning([prompt, said, interrupted, notice]), false, "waiting after the interrupt");
  assert.equal(turnRunning([prompt, said, interrupted, notice, next, said]), true, "the next message started a turn");
});

test("one Stop: it interrupts a working interruptible agent, rests while it waits, and ends other runs", () => {
  assert.equal(stopAction(true, [prompt, said]), "interrupt");
  assert.equal(stopAction(true, [prompt, said, interrupted, notice]), "none", "never ends the run: nothing to stop while it waits");
  assert.equal(stopAction(true, [prompt, said, interrupted, notice, next]), "interrupt", "the next message is a turn to stop again");
  assert.equal(stopAction(false, [prompt, said]), "end", "an agent that cannot be interrupted is stopped, as before");
});

test("the server's word on the turn wins over the transcript", () => {
  // A message sent mid turn: Claude Code ends the turn, then takes it as one more.
  const queued: AgentEvent[] = [prompt, said, next, { type: "result", ok: true }];
  assert.equal(turnRunning(queued), false, "the transcript reads the result as the end");
  assert.equal(turnRunning(queued, "working"), true, "the server knows the next turn is under way");
  assert.equal(stopAction(true, queued, "working"), "interrupt");
  assert.equal(stopAction(true, [prompt, said], "waiting"), "none");
  assert.equal(stopAction(false, [prompt, said], "waiting"), "end", "a run that cannot be interrupted is stopped, whatever the turn");
});
