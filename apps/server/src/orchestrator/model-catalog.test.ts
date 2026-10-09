import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogModelCount, installModelCatalog, providersForCli, resetModelCatalog } from "@bento/core";
import { pullModelCatalog, refreshModelCatalog } from "./model-catalog.js";

const priced = (id: string, name: string) => ({
  id,
  name,
  tool_call: true,
  modalities: { input: ["text"], output: ["text"] },
  cost: { input: 3, output: 15 },
});

function payload() {
  return {
    anthropic: { name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: { "claude-opus-5-5": priced("claude-opus-5-5", "Claude Opus 5.5") } },
    openai: { name: "OpenAI", env: ["OPENAI_API_KEY"], models: { "gpt-6-astra": priced("gpt-6-astra", "GPT-6 Astra") } },
    google: { name: "Google", env: ["GEMINI_API_KEY"], models: { "gemini-test": priced("gemini-test", "Gemini Test") } },
    openrouter: { name: "OpenRouter", env: ["OPENROUTER_API_KEY"], models: { "openrouter/auto": priced("openrouter/auto", "Auto") } },
    xai: { name: "xAI", models: { "grok-4.6": priced("grok-4.6", "Grok 4.6") } },
  };
}

function fetchImpl(status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (status !== 200 && url.includes("api.json")) {
      return new Response("no", { status });
    }
    if (url.includes("api.json")) return Response.json(payload());
    if (url.includes("/v1/models")) {
      return Response.json({ data: [{ id: "openai/gpt-6-astra", name: "GPT-6 Astra", type: "language" }] });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

test("a pull keeps Opus 5.5 and GPT-6 Astra and drops a failed fetch", async () => {
  const pulled = await pullModelCatalog(fetchImpl());
  assert.equal(pulled.ok, true);
  if (!pulled.ok) return;
  assert.ok(pulled.generated.find((provider) => provider.id === "anthropic")?.models.some((model) => model.id === "claude-opus-5-5"));
  assert.ok(pulled.generated.find((provider) => provider.id === "openai")?.models.some((model) => model.id === "gpt-6-astra"));
  assert.equal(pulled.generated.find((provider) => provider.id === "xai")?.env[0], "CURSOR_API_KEY");
  const failed = await pullModelCatalog(fetchImpl(503));
  assert.equal(failed.ok, false);
});

test("a refresh serves the fetched list and a refusal does not replace it", async () => {
  const writes: unknown[] = [];
  const db = {
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: async () => {
          writes.push(row);
        },
      }),
    }),
  };
  const before = catalogModelCount(providersForCli("codex"));
  try {
    const refused = await refreshModelCatalog({ db: db as never }, fetchImpl());
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.match(refused.reason, /under half/);
    assert.equal(writes.length, 0);
    assert.equal(catalogModelCount(providersForCli("codex")), before);

    const pulled = await pullModelCatalog(fetchImpl());
    assert.equal(pulled.ok, true);
    if (!pulled.ok) return;
    assert.equal(installModelCatalog([...pulled.generated, ...pulled.gateway]), true);

    const refreshed = await refreshModelCatalog({ db: db as never }, fetchImpl());
    assert.equal(refreshed.ok, true);
    assert.equal(writes.length, 1);
    assert.ok(providersForCli("codex").find((provider) => provider.id === "openai")?.models.some((model) => model.id === "gpt-6-astra"));
    assert.ok(providersForCli("claude-code").find((provider) => provider.id === "anthropic")?.models.some((model) => model.id === "claude-opus-5-5"));
    assert.ok(providersForCli("cursor").find((provider) => provider.id === "cursor")?.models.some((model) => model.id === "composer-2.5"));
  } finally {
    resetModelCatalog();
  }
});
