import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_CREDENTIALS,
  MODEL_GUIDANCE,
  modelGuidanceFor,
  spendCoverageNote,
  spendReportingTools,
} from "./credentials.js";
import { agentCli } from "./enums.js";

test("dsh is a registered agent CLI", () => {
  assert.equal(agentCli.parse("dsh"), "dsh");
});

test("every agent CLI has model guidance", () => {
  // A tool with no guidance leaves the model field unexplained, and the
  // formats genuinely differ between tools.
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "pool", "dsh", "antigravity", "fake"]) {
    const guidance = modelGuidanceFor(cli);
    assert.ok(guidance, `${cli} has no model guidance`);
    assert.ok(guidance.examples.length > 0, `${cli} offers no example model`);
  }
  assert.equal(MODEL_GUIDANCE.length, 9);
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
  assert.match(
    note,
    /Codex CLI, Cursor CLI, opencode, Poolside \(pool\), DeepSeek Harness and Antigravity CLI report none/,
  );
  // The commoner reason a figure is missing, and the one the tool list
  // alone would misattribute.
  assert.match(note, /fails before finishing reports nothing/);
  assert.match(note, /floor rather than a full total/);
  // The fake agent reports a cost but is a test fixture, not a choice.
  assert.doesNotMatch(note, /Fake agent/);
});

test("the spend page's two lists match the coverage sentence", () => {
  const { reporting, silent } = spendReportingTools();
  assert.deepEqual(reporting, ["Claude Code", "pi"]);
  assert.deepEqual(silent, [
    "Codex CLI",
    "Cursor CLI",
    "opencode",
    "Poolside (pool)",
    "DeepSeek Harness",
    "Antigravity CLI",
  ]);
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

test("the DeepSeek key and Harness base URL are storable", () => {
  const key = AGENT_CREDENTIALS.find((c) => c.name === "DEEPSEEK_API_KEY");
  assert.ok(key, "DEEPSEEK_API_KEY cannot be stored");
  assert.equal(key.secret, true);
  const baseUrl = AGENT_CREDENTIALS.find((c) => c.name === "DEEPSEEK_BASE_URL");
  assert.ok(baseUrl, "DEEPSEEK_BASE_URL cannot be stored");
  assert.equal(baseUrl.secret, false);
  assert.match(key.help, /DeepSeek Harness/);
});

test("dsh guidance uses bare DeepSeek ids and the pinned installer", () => {
  const guidance = modelGuidanceFor("dsh")!;
  assert.equal(guidance.defaultModel, "deepseek-v4-pro");
  assert.equal(guidance.bareModelId, true);
  assert.equal(guidance.installCommand, "npm install -g @deepseek-ai/dsh@0.1.1-rc.2");
  assert.equal(MODEL_GUIDANCE.at(-3)?.cli, "dsh");
  assert.equal(MODEL_GUIDANCE.at(-1)?.cli, "fake");
});

/**
 * Antigravity slugs name the model tier and its reasoning effort
 * together, which is not what the Gemini API calls a model, so a
 * provider-prefixed string is refused the way dsh's is.
 */
test("antigravity guidance uses Antigravity's own slugs and its installer", () => {
  const guidance = modelGuidanceFor("antigravity")!;
  assert.equal(guidance.defaultModel, "gemini-3.1-pro-high");
  assert.equal(guidance.bareModelId, true);
  assert.equal(guidance.binary, "agy");
  assert.match(guidance.installCommand, /antigravity\.google\/cli\/install\.sh/);
  assert.equal(MODEL_GUIDANCE.at(-2)?.cli, "antigravity");
});

test("the Gemini key and Antigravity's base URL are storable", () => {
  const key = AGENT_CREDENTIALS.find((c) => c.name === "GEMINI_API_KEY");
  assert.ok(key, "GEMINI_API_KEY cannot be stored");
  assert.equal(key.secret, true);
  assert.match(key.help, /Antigravity/);
  const baseUrl = AGENT_CREDENTIALS.find((c) => c.name === "GOOGLE_GEMINI_BASE_URL");
  assert.ok(baseUrl, "GOOGLE_GEMINI_BASE_URL cannot be stored");
  assert.equal(baseUrl.secret, false);
});

/**
 * The catalog is the list; two deployment surfaces repeat it by hand.
 *
 * A credential the catalog can store but a deployment cannot supply is
 * a key nobody can use: local mode reads the process environment, and
 * the Compose stack only forwards what its `environment:` block names.
 * Poolside shipped missing from both, and was noticed only because
 * DeepSeek was added next to it. Nothing was checking.
 *
 * Base URLs are excluded on purpose: they point a tool somewhere else
 * from the console, rather than being keys an operator seeds a
 * deployment with.
 */
test("every storable key can be supplied through a deployment's environment", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const envExample = await readFile(path.join(root, ".env.example"), "utf8");
  const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");

  for (const credential of AGENT_CREDENTIALS.filter((c) => c.secret)) {
    assert.match(
      envExample,
      new RegExp(`^${credential.name}=`, "m"),
      `${credential.name} is storable but absent from .env.example, so nobody is told it exists`,
    );
    assert.match(
      compose,
      new RegExp(`^\\s+- ${credential.name}=`, "m"),
      `${credential.name} is storable but the Compose server never receives it`,
    );
  }
});
