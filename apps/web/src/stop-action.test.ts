import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@bento/core";
import { stopAction, turnRunning } from "./stop-action.js";

const prompt: AgentEvent = { type: "message", role: "user", text: "Do the task" };
const said: AgentEvent = { type: "message", role: "assistant", text: "Working on it" };
const tool: AgentEvent = { type: "tool", name: "bash", phase: "start" };
const interrupted: AgentEvent = { type: "result", ok: false, interrupted: true, error: "Interrupted." };
const notice: AgentEvent = { type: "message", role: "system", text: "Stopped. Waiting for your next message." };
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
