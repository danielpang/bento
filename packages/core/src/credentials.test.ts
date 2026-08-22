import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CREDENTIALS, MODEL_GUIDANCE, modelGuidanceFor, spendCoverageNote } from "./credentials.js";

test("every agent CLI has model guidance", () => {
  // A tool with no guidance leaves the model field unexplained, and the
  // formats genuinely differ between tools.
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "pool", "fake"]) {
    const guidance = modelGuidanceFor(cli);
    assert.ok(guidance, `${cli} has no model guidance`);
    assert.ok(guidance.examples.length > 0, `${cli} offers no example model`);
  }
  assert.equal(MODEL_GUIDANCE.length, 7);
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
  assert.match(note, /Codex CLI, Cursor CLI, opencode and Poolside \(pool\) report none/);
  // The commoner reason a figure is missing, and the one the tool list
  // alone would misattribute.
  assert.match(note, /fails before finishing reports nothing/);
  assert.match(note, /floor rather than a full total/);
  // The fake agent reports a cost but is a test fixture, not a choice.
  assert.doesNotMatch(note, /Fake agent/);
});

/**
 * pool takes its model as an environment variable rather than a flag,
 * so the guidance's default is the string that ends up in
 * POOLSIDE_STANDALONE_MODEL. It carries the vendor prefix, which is
 * what Poolside's inference API accepts.
 */
test("pool's guidance names the prefixed id and its own installer", () => {
  const guidance = modelGuidanceFor("pool")!;
  assert.equal(guidance.defaultModel, "poolside/laguna-s-2.1");
  assert.equal(guidance.binary, "pool");
  assert.match(guidance.installCommand, /downloads\.poolside\.ai/);
  // The one place in the product that tells someone the OpenRouter
  // route to the same weights exists, because this is where they are
  // choosing.
  assert.match(guidance.format, /OpenRouter/);
});

test("the Poolside key is storable", () => {
  const key = AGENT_CREDENTIALS.find((c) => c.name === "POOLSIDE_API_KEY");
  assert.ok(key, "POOLSIDE_API_KEY cannot be stored");
  assert.equal(key.secret, true);
  assert.equal(
    AGENT_CREDENTIALS.some((c) => c.name === "POOLSIDE_STANDALONE_BASE_URL"),
    false,
    "enterprise endpoints are outside the hosted v1 settings",
  );
});
