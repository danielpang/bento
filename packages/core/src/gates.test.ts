import { test } from "node:test";
import assert from "node:assert/strict";
import { gateCriteria } from "./gates.js";
import { DEFAULT_STAGES } from "./pipeline.js";

test("command criterion defaults timeout", () => {
  const parsed = gateCriteria.parse([{ type: "command", cmd: "pnpm test" }]);
  assert.equal(parsed[0]?.type, "command");
  if (parsed[0]?.type === "command") {
    assert.equal(parsed[0].timeoutSec, 600);
  }
});

test("rejects unknown criterion types", () => {
  assert.throws(() => gateCriteria.parse([{ type: "nope" }]));
});

test("default pipeline has three valid stages", () => {
  assert.equal(DEFAULT_STAGES.length, 3);
  for (const stage of DEFAULT_STAGES) {
    gateCriteria.parse(stage.gateCriteria);
  }
});

/**
 * Every seeded stage publishes. A first card should reach GitHub
 * without anyone hunting for the setting, and a stage that stays quiet
 * is a choice somebody makes, not a default they trip over.
 */
test("every default stage opens a pull request", () => {
  for (const stage of DEFAULT_STAGES) {
    assert.equal(stage.createPr, true, `${stage.slug} should publish by default`);
  }
});
