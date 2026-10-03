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
 * The stages that commit code publish by default; the planning stage
 * does not. A first card should reach GitHub without anyone hunting
 * for the setting, and a plan should not push an empty branch.
 */
test("default pipeline opens pull requests from implementation and code review", () => {
  assert.deepEqual(
    DEFAULT_STAGES.map((stage) => [stage.slug, stage.createPr]),
    [
      ["engineering-requirements", false],
      ["implementation", true],
      ["code-review", true],
    ],
  );
});
