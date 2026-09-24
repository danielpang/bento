import test from "node:test";
import assert from "node:assert/strict";
import {
  codingModelsOnly,
  isCodingModel,
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
  providerById,
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
      "claude-test-9": { id: "claude-test-9", name: "Claude Test 9", tool_call: true },
      "claude-opus-5": { id: "claude-opus-5", name: "Claude Opus 5" },
      "claude-retired-1": { id: "claude-retired-1", status: "deprecated" },
    },
  },
  openai: {
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-test-9-sol": { id: "gpt-test-9-sol", name: "GPT Test 9 Sol" },
      "gpt-image-3": { id: "gpt-image-3", modalities: { input: ["text", "image"], output: ["image"] } },
      "text-embedding-4": { id: "text-embedding-4" },
      "gpt-realtime-3": { id: "gpt-realtime-3" },
      "o-no-tools": { id: "o-no-tools", tool_call: false },
      "gpt-transcriber": { id: "gpt-transcriber", modalities: { input: ["audio"], output: ["text"] } },
    },
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

test("only models a coding agent can run are listed", () => {
  // Image, embedding, realtime, no tool calling, audio in: all out.
  assert.deepEqual(parseModelsDev(modelsDev)[1]!.models.map((m) => m.id), ["gpt-test-9-sol"]);

  for (const id of ["gpt-image-2", "chatgpt-image-latest", "text-embedding-3-large", "gemini-3.1-flash-live-preview",
    "gemini-2.5-pro-preview-tts", "veo-3.1-generate-preview", "openai/gpt-audio", "google/lyria-3-pro-preview"]) {
    assert.equal(isCodingModel(id), false, id);
  }
  // Whole words only: these merely contain the letters.
  for (const id of ["claude-opus-5-5", "gpt-5.6-sol", "gpt-5.3-codex", "deepseek-v4-pro", "moonshotai/kimi-k3", "olive-1"]) {
    assert.equal(isCodingModel(id), true, id);
  }

  // The committed snapshot is cleaned the same way.
  const openai = MODEL_CATALOG.find((p) => p.id === "openai")!;
  assert.ok(openai.models.some((m) => m.id === "gpt-5.5"));
  assert.ok(!openai.models.some((m) => m.id.includes("image") || m.id.includes("embedding")));
  assert.deepEqual(codingModelsOnly([{ id: "x", name: "X", env: [], logo: "", models: [{ id: "gpt-image-1", name: "" }] }]), []);
});

test("the Gateway list keeps language models only", () => {
  const parsed = parseGatewayModels({
    data: [
      { id: "openai/gpt-image-2", type: "image" },
      { id: "acme/coder-1", type: "language", name: "Coder 1" },
      { id: "openai/gpt-audio", type: "language" },
      { id: "moonshotai/kimi-k3", type: "language", name: "Kimi K3" },
    ],
  });
  assert.equal(parsed[0]?.id, "vercel");
  assert.deepEqual(parsed[0]!.models.map((m) => m.id), ["moonshotai/kimi-k3", "acme/coder-1"]);
  assert.deepEqual(parseGatewayModels({ data: [] }), []);
});

test("a live list replaces the base list, and a provider it lacks keeps its own", () => {
  const base: CatalogProvider[] = [
    { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], logo: "data:mark", models: [{ id: "claude-old", name: "Old" }, { id: "claude-sunset", name: "Sunset" }] },
    { id: "google", name: "Google", env: ["GEMINI_API_KEY"], logo: "", models: [{ id: "gemini-3", name: "Gemini 3" }] },
  ];
  const live: CatalogProvider[] = [
    { id: "anthropic", name: "Anthropic (live)", env: [], logo: "", models: [{ id: "claude-new", name: "New" }, { id: "claude-old", name: "Old (live)" }] },
    { id: "brandnew", name: "Brand New", env: [], logo: "", models: [{ id: "x", name: "X" }] },
  ];
  const merged = overlayCatalog(base, live);
  assert.deepEqual(merged.map((p) => p.id), ["anthropic", "google", "brandnew"]);
  const anthropic = merged[0]!;
  assert.deepEqual(anthropic.models.map((m) => m.id), ["claude-new", "claude-old"]);
  assert.equal(anthropic.logo, "data:mark");
  assert.deepEqual(anthropic.env, ["ANTHROPIC_API_KEY"]);
  assert.equal(merged[1], base[1]);
});

test("a live refresh makes a new model pickable and a sunset one go", () => {
  assert.equal(providerForProfile("codex", "gpt-test-9-sol"), undefined);
  assert.equal(checkAgentPairing("codex", "gpt-test-9-sol").status, "unknown");
  assert.ok(providerById("anthropic")!.models.some((m) => m.id === "claude-sonnet-4-5"));

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

  const anthropic = providerById("anthropic")!;
  // models.dev no longer lists it, so it is gone.
  assert.ok(!anthropic.models.some((m) => m.id === "claude-sonnet-4-5"));
  // Deprecated by the provider: not listed even though models.dev still carries it.
  assert.ok(!anthropic.models.some((m) => m.id === "claude-retired-1"));
  // Hand-maintained ids stay: no source describes them, so none retires them.
  assert.ok(anthropic.models.some((m) => m.id === "claude-opus-5-5"));
  assert.ok(providerById("cursor")!.models.some((m) => m.id === "composer-2.5"));
  // Google was not in the live read, so it keeps its snapshot list.
  assert.deepEqual(providerById("google"), MODEL_CATALOG.find((p) => p.id === "google"));
  // The logo survives the replacement.
  assert.equal(anthropic.logo, MODEL_CATALOG.find((p) => p.id === "anthropic")!.logo);

  // A client applying what the server served lands on the same catalog.
  const served = modelCatalog();
  applyLiveCatalog(served);
  assert.deepEqual(modelCatalog(), served);

  applyLiveCatalog([]);
  assert.deepEqual(modelCatalog(), MODEL_CATALOG);
});
