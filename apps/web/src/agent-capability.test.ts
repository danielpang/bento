import assert from "node:assert/strict";
import test from "node:test";
import { toolCapability } from "./components/ui.js";

test("DeepSeek Harness capabilities admit its quiet cold-run behavior", () => {
  const copy = toolCapability("dsh");
  assert.match(copy, /Prints nothing until the run ends/);
  assert.match(copy, /as a new run/);
  assert.match(copy, /Cost is not reported/);
});

test("existing live tools retain their distinct delivery promises", () => {
  assert.match(toolCapability("pi"), /Messages steer it while it works/);
  assert.match(toolCapability("claude-code"), /same conversation/);
});
