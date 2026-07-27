import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CREDENTIALS, MODEL_GUIDANCE, modelGuidanceFor, spendCoverageNote } from "./credentials.js";

test("every agent CLI has model guidance", () => {
  // A tool with no guidance leaves the model field unexplained, and the
  // formats genuinely differ between tools.
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "fake"]) {
    const guidance = modelGuidanceFor(cli);
    assert.ok(guidance, `${cli} has no model guidance`);
    assert.ok(guidance.examples.length > 0, `${cli} offers no example model`);
  }
  assert.equal(MODEL_GUIDANCE.length, 6);
});

test("the provider agnostic tools show how to reach OpenRouter", () => {
  for (const cli of ["opencode", "pi"]) {
    const guidance = modelGuidanceFor(cli)!;
    assert.match(guidance.format, /openrouter/i, `${cli} should explain OpenRouter routing`);
    assert.ok(
      guidance.examples.some((e) => e.startsWith("openrouter/")),
      `${cli} should show an OpenRouter example`,
    );
  }
});

/**
 * The spend caveat names tools, so it has to be derived rather than
 * written down: a sentence claiming Codex runs are counted would be
 * worse than no sentence at all.
 */
test("the spend note names exactly the tools that report a cost", () => {
  const note = spendCoverageNote();
  assert.match(note, /Only Claude Code and pi report/);
  assert.match(note, /Codex CLI, Cursor CLI and opencode report none/);
  // The commoner reason a figure is missing, and the one the tool list
  // alone would misattribute.
  assert.match(note, /fails before finishing reports nothing/);
  assert.match(note, /floor rather than a full total/);
  // The fake agent reports a cost but is a test fixture, not a choice.
  assert.doesNotMatch(note, /Fake agent/);
});
