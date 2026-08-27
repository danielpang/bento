import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGate } from "./latest-request.js";

test("a newer request invalidates every earlier one", () => {
  const gate = createRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("the first request is current until another starts", () => {
  const gate = createRequestGate();
  const first = gate.next();
  assert.equal(gate.isCurrent(first), true);
});
