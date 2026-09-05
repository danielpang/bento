import assert from "node:assert/strict";
import test from "node:test";
import { toolCapabilities, toolCapability } from "./components/ui.js";

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

/**
 * The chips are what someone actually reads while picking a coding
 * agent, so the two facts have to be there and be distinguishable. A
 * tool that steers and one that queues once shared an icon, which made
 * the row decoration rather than information.
 */
test("every tool offers exactly one messaging fact and one cost fact", () => {
  for (const cli of ["pi", "claude-code", "dsh", "codex", "antigravity"]) {
    const chips = toolCapabilities(cli);
    assert.equal(chips.length, 2, `${cli} shows two chips`);
    assert.ok(
      ["steer", "queue", "between-runs"].includes(chips[0]!.icon),
      `${cli} says whether it can be messaged mid-run`,
    );
    assert.ok(["cost", "no-cost"].includes(chips[1]!.icon), `${cli} says whether it reports cost`);
    for (const chip of chips) {
      assert.ok(chip.label.length <= 16, `"${chip.label}" is short enough to sit in a chip`);
      assert.ok(chip.detail.endsWith("."), "the hover text is a full sentence");
    }
  }
});

test("mid-run messaging is distinguished, not flattened to one icon", () => {
  assert.equal(toolCapabilities("pi")[0]!.icon, "steer");
  assert.equal(toolCapabilities("claude-code")[0]!.icon, "queue");
  assert.equal(toolCapabilities("dsh")[0]!.icon, "between-runs");
  assert.equal(toolCapabilities("antigravity")[0]!.icon, "between-runs");
});

/** The sentence and the chips come from one source, so they cannot drift. */
test("the sentence form still contains what the chips say", () => {
  for (const cli of ["pi", "claude-code", "dsh"]) {
    for (const chip of toolCapabilities(cli)) {
      assert.ok(toolCapability(cli).includes(chip.detail), `${cli}: ${chip.detail}`);
    }
  }
});
