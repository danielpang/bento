import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGatewayCatalog,
  buildModelsDevCatalog,
  catalogModelCount,
  isCatalogProviderList,
  refuseFreshCatalog,
} from "./model-catalog-build.js";
import { installModelCatalog, providersForCli, resetModelCatalog } from "./models.js";

const priced = (id: string, name: string) => ({
  id,
  name,
  tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
  cost: { input: 1, output: 2 },
});

function api() {
  return {
    anthropic: { name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: { "claude-opus-5-5": priced("claude-opus-5-5", "Claude Opus 5.5") } },
    openai: {
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-6-astra": priced("gpt-6-astra", "GPT-6 Astra"),
        "gpt-image-2": priced("gpt-image-2", "GPT Image 2"),
      },
    },
    google: { name: "Google", env: ["GEMINI_API_KEY"], models: { "gemini-test": priced("gemini-test", "Gemini Test") } },
    openrouter: { name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: { "openrouter/auto": priced("openrouter/auto", "Auto") } },
    xai: { name: "xAI", models: { "grok-4.6": priced("grok-4.6", "Grok 4.6"), "grok-imagine": { ...priced("grok-imagine", "Imagine"), tool_call: false } } },
  };
}

test("a models.dev payload keeps coding models and drops image and tool-less ones", () => {
  const built = buildModelsDevCatalog(api(), { anthropic: "data:image/svg+xml;base64,YQ==" });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const openai = built.providers.find((provider) => provider.id === "openai");
  assert.deepEqual(openai?.models.map((model) => model.id), ["gpt-6-astra"]);
  assert.equal(openai?.models[0]?.cost?.input, 1);
  const anthropic = built.providers.find((provider) => provider.id === "anthropic");
  assert.equal(anthropic?.models[0]?.id, "claude-opus-5-5");
  assert.equal(anthropic?.logo, "data:image/svg+xml;base64,YQ==");
  const xai = built.providers.find((provider) => provider.id === "xai");
  assert.deepEqual(xai?.env, ["CURSOR_API_KEY"]);
  assert.deepEqual(xai?.models.map((model) => model.id), ["grok-4.6"]);
  assert.equal(built.providers.find((provider) => provider.id === "openrouter")?.models[0]?.id, "openrouter/auto");
});

test("a provider with no prices is refused", () => {
  const source = api();
  source.openai.models["gpt-6-astra"] = { id: "gpt-6-astra", name: "GPT-6 Astra", tool_call: true };
  const built = buildModelsDevCatalog(source);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.reason, /openai/);
});

test("the gateway keeps language slugs and drops image ids", () => {
  const built = buildGatewayCatalog({
    data: [
      { id: "openai/gpt-6-astra", name: "GPT-6 Astra", type: "language" },
      { id: "openai/gpt-image-2", name: "GPT Image 2", type: "language" },
      { id: "vendor/embed", name: "Embed", type: "embedding" },
    ],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.providers[0]?.models.map((model) => model.id), ["openai/gpt-6-astra"]);
  assert.equal(built.providers[0]?.models[0]?.cost, undefined);
});

test("a refresh that drops more than half the list is refused", () => {
  assert.equal(refuseFreshCatalog(100, 50), null);
  assert.equal(refuseFreshCatalog(100, 80), null);
  assert.match(refuseFreshCatalog(100, 49) ?? "", /under half/);
  assert.equal(refuseFreshCatalog(0, 10), null);
});

test("installing a fetched catalog is what the picker reads, and a bad payload is not", () => {
  const built = buildModelsDevCatalog(api());
  const gateway = buildGatewayCatalog({ data: [{ id: "openai/gpt-6-astra", name: "GPT-6 Astra", type: "language" }] });
  assert.equal(built.ok && gateway.ok, true);
  if (!built.ok || !gateway.ok) return;
  try {
    assert.equal(installModelCatalog([...built.providers, ...gateway.providers]), true);
    assert.ok(providersForCli("codex").find((provider) => provider.id === "openai")?.models.some((model) => model.id === "gpt-6-astra"));
    assert.equal(installModelCatalog([]), false);
    assert.ok(providersForCli("codex").find((provider) => provider.id === "openai")?.models.some((model) => model.id === "gpt-6-astra"));
    assert.equal(isCatalogProviderList(built.providers), true);
    assert.equal(isCatalogProviderList([{ id: "anthropic" }]), false);
  } finally {
    resetModelCatalog();
  }
  const restored = providersForCli("codex").find((provider) => provider.id === "openai");
  assert.ok(restored && catalogModelCount([restored]) > 1);
  assert.ok(restored?.models.some((model) => model.id === "gpt-5.4"));
});
