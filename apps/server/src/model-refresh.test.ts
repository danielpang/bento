import test from "node:test";
import assert from "node:assert/strict";
import { GATEWAY_MODELS_URL, MODELS_DEV_URL, applyLiveCatalog, providerForProfile } from "@bento/core";
import { fetchLiveCatalog, startModelRefresh } from "./model-refresh.js";

const quiet = { log() {}, warn() {} };

test("a refresh serves models released after the snapshot", async () => {
  const fetchStub = (async (url: string) =>
    url.includes("models.dev")
      ? Response.json({ openai: { name: "OpenAI", models: { "gpt-test-9-sol": { id: "gpt-test-9-sol", name: "GPT Test 9 Sol" } } } })
      : new Response("down", { status: 503 })) as typeof fetch;
  // 0 hours: no timer, no boot read, so the test drives it.
  const refresher = startModelRefresh({ hours: 0, fetch: fetchStub, log: quiet });
  assert.equal(providerForProfile("codex", "gpt-test-9-sol"), undefined);
  await refresher.refresh();
  assert.equal(providerForProfile("codex", "gpt-test-9-sol")?.id, "openai");
  applyLiveCatalog([]);
});

test("a failed refresh keeps the last good list and warns once", async () => {
  let ok = true;
  const warnings: string[] = [];
  const fetchStub = (async (url: string) =>
    ok && url.includes("models.dev")
      ? Response.json({ anthropic: { name: "Anthropic", models: { "claude-test-9": { id: "claude-test-9" } } } })
      : new Response("down", { status: 503 })) as typeof fetch;
  const refresher = startModelRefresh({ hours: 0, fetch: fetchStub, log: { log() {}, warn: (m: string) => warnings.push(m) } });
  await refresher.refresh();
  ok = false;
  await refresher.refresh();
  await refresher.refresh();
  assert.equal(warnings.length, 1);
  assert.equal(providerForProfile("claude-code", "claude-test-9")?.id, "anthropic");
  applyLiveCatalog([]);
});

const modelsDev = {
  anthropic: { name: "Anthropic", models: { "claude-test-9": { id: "claude-test-9" } } },
  openai: { name: "OpenAI", models: { "gpt-test-9-sol": { id: "gpt-test-9-sol" } } },
};

test("one source failing does not hold back the other", async () => {
  const fetchOne = (failing: string) =>
    (async (url: string) => {
      if (url === failing) return new Response("down", { status: 503 });
      if (url === MODELS_DEV_URL) return Response.json(modelsDev);
      return Response.json({ data: [{ id: "acme/coder-1", type: "language" }] });
    }) as typeof fetch;

  const withoutGateway = await fetchLiveCatalog({ fetch: fetchOne(GATEWAY_MODELS_URL) });
  assert.deepEqual(withoutGateway.map((p) => p.id), ["anthropic", "openai"]);
  const withoutModelsDev = await fetchLiveCatalog({ fetch: fetchOne(MODELS_DEV_URL) });
  assert.deepEqual(withoutModelsDev.map((p) => p.id), ["vercel"]);

  const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
  await assert.rejects(fetchLiveCatalog({ fetch: down }), /returned 503/);
});
