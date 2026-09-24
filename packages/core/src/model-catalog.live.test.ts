import test from "node:test";
import assert from "node:assert/strict";
import {
  overlayCatalog,
  parseGatewayModels,
  parseModelsDev,
} from "./model-catalog.live.js";
import {
  applyLiveCatalog,
  checkAgentPairing,
  modelCatalog,
  modelCatalogVersion,
  MODEL_CATALOG,
  providerForProfile,
  providersForCli,
  subscribeModelCatalog,
  type CatalogProvider,
} from "./models.js";

const modelsDev = {
  anthropic: {
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {
      "claude-test-9": { id: "claude-test-9", name: "Claude Test 9" },
      "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5" },
    },
  },
  openai: {
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: { "gpt-test-9-sol": { id: "gpt-test-9-sol", name: "GPT Test 9 Sol" } },
  },
  xai: {
    name: "xAI",
    env: ["XAI_API_KEY"],
    models: {
      "grok-imagine": { id: "grok-imagine", modalities: { output: ["image"] } },
      "grok-4.5": { id: "grok-4.5", name: "Grok 4.5" },
      "grok-4.6": { id: "grok-4.6", name: "Grok 4.6" },
    },
  },
  // Not a provider Bento stores a key for.
  mistral: { name: "Mistral", models: { "mistral-large": { id: "mistral-large" } } },
};

test("models.dev is narrowed the way the snapshot script narrows it", () => {
  const parsed = parseModelsDev(modelsDev);
  assert.deepEqual(parsed.map((p) => p.id), ["anthropic", "openai", "xai"]);
  assert.deepEqual(parsed[0]!.models.map((m) => m.id), ["claude-opus-5", "claude-test-9"]);
  const xai = parsed[2]!;
  // Grok is billed through the Cursor key, image models drop, pins lead.
  assert.deepEqual(xai.env, ["CURSOR_API_KEY"]);
  assert.deepEqual(xai.models.map((m) => m.id), ["grok-4.6", "grok-4.5"]);
  assert.deepEqual(parseModelsDev("not json"), []);
});

test("the Gateway list keeps language models only", () => {
  const parsed = parseGatewayModels({
    data: [
      { id: "openai/gpt-image-2", type: "image" },
      { id: "acme/coder-1", type: "language", name: "Coder 1" },
      { id: "moonshotai/kimi-k3", type: "language", name: "Kimi K3" },
    ],
  });
  assert.equal(parsed[0]?.id, "vercel");
  assert.deepEqual(parsed[0]!.models.map((m) => m.id), ["moonshotai/kimi-k3", "acme/coder-1"]);
  assert.deepEqual(parseGatewayModels({ data: [] }), []);
});

test("an overlay adds what is new and never drops what the base had", () => {
  const base: CatalogProvider[] = [
    { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], logo: "data:mark", models: [{ id: "claude-old", name: "Old" }, { id: "claude-hand", name: "Hand" }] },
    { id: "cursor", name: "Cursor", env: ["CURSOR_API_KEY"], logo: "", models: [{ id: "auto", name: "Auto" }] },
  ];
  const live: CatalogProvider[] = [
    { id: "anthropic", name: "Anthropic (live)", env: [], logo: "", models: [{ id: "claude-new", name: "New" }, { id: "claude-old", name: "Old (live)" }] },
    { id: "brandnew", name: "Brand New", env: [], logo: "", models: [{ id: "x", name: "X" }] },
  ];
  const merged = overlayCatalog(base, live);
  assert.deepEqual(merged.map((p) => p.id), ["anthropic", "cursor", "brandnew"]);
  const anthropic = merged[0]!;
  assert.deepEqual(anthropic.models.map((m) => m.id), ["claude-new", "claude-old", "claude-hand"]);
  assert.equal(anthropic.logo, "data:mark");
  assert.deepEqual(anthropic.env, ["ANTHROPIC_API_KEY"]);
  assert.equal(merged[1], base[1]);
});

test("a live refresh makes a new model pickable and checkable", () => {
  assert.equal(providerForProfile("codex", "gpt-test-9-sol"), undefined);
  assert.equal(checkAgentPairing("codex", "gpt-test-9-sol").status, "unknown");

  let heard = 0;
  const unsubscribe = subscribeModelCatalog(() => heard++);
  const before = modelCatalogVersion();
  applyLiveCatalog(parseModelsDev(modelsDev));
  unsubscribe();

  assert.equal(heard, 1);
  assert.notEqual(modelCatalogVersion(), before);
  assert.equal(providerForProfile("codex", "gpt-test-9-sol")?.id, "openai");
  assert.equal(checkAgentPairing("codex", "gpt-test-9-sol").status, "ok");
  assert.ok(providersForCli("claude-code")[0]!.models.some((m) => m.id === "claude-test-9"));
  // Now that the catalog knows it is OpenAI's, Claude Code refuses it.
  assert.equal(checkAgentPairing("claude-code", "gpt-test-9-sol").status, "impossible");
  // The snapshot underneath is intact.
  for (const provider of MODEL_CATALOG) {
    const now = modelCatalog().find((p) => p.id === provider.id)!;
    for (const model of provider.models) assert.ok(now.models.some((m) => m.id === model.id), model.id);
  }

  applyLiveCatalog([]);
  assert.equal(providerForProfile("codex", "gpt-test-9-sol"), undefined);
});
