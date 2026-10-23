import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedGrant } from "./grants.js";
import { ModelProxyCache } from "./model-proxy-cache.js";

function grant(runId: string, expiresInMs = 60 * 60_000): ResolvedGrant {
  return {
    id: `grant-${runId}`,
    runId,
    organizationId: "org",
    actingUserId: null,
    serverIds: [],
    modelCredentials: ["ANTHROPIC_API_KEY"],
    swarmId: null,
    expiresAt: new Date(Date.now() + expiresInMs),
    proxyFailed: false,
  };
}

test("an entry and its decrypted keys are gone at the TTL, asked for or not", async () => {
  const cache = new ModelProxyCache(40);
  const entry = cache.put("hash-a", grant("run-a"), cache.generation);
  cache.putCredentials(entry, "ANTHROPIC_API_KEY", { key: "sk-real", savedBase: null }, cache.generation);
  assert.equal(cache.get("hash-a")?.credentials.get("ANTHROPIC_API_KEY")?.key, "sk-real");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(cache.size, 0, "the timer dropped it");
  assert.equal(cache.get("hash-a"), undefined);
  assert.equal(entry.credentials.size, 0, "the keys were cleared with it");
});

test("a grant that expires before the TTL lapses with it", async () => {
  const cache = new ModelProxyCache(60 * 60_000);
  cache.put("hash-b", grant("run-b", 30), cache.generation);
  assert.ok(cache.get("hash-b"));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cache.get("hash-b"), undefined);
});

test("a run's end drops every token of that run, and only that run", () => {
  const cache = new ModelProxyCache();
  cache.put("hash-1", grant("run-1"), cache.generation);
  cache.put("hash-2", grant("run-1"), cache.generation);
  cache.put("hash-3", grant("run-2"), cache.generation);
  cache.evictRun("run-1");
  assert.equal(cache.get("hash-1"), undefined);
  assert.equal(cache.get("hash-2"), undefined);
  assert.ok(cache.get("hash-3"));
  cache.clear();
  assert.equal(cache.size, 0);
});

test("a lookup that raced an eviction serves its request and is not remembered", () => {
  const cache = new ModelProxyCache();
  const before = cache.generation;
  // The run ended while its grant was being read.
  cache.evictRun("run-x");
  const entry = cache.put("hash-x", grant("run-x"), before);
  assert.equal(entry.grant.runId, "run-x", "the request still has its grant");
  assert.equal(cache.get("hash-x"), undefined, "but the cache does not");

  const kept = cache.put("hash-y", grant("run-y"), cache.generation);
  const readAt = cache.generation;
  cache.evictRun("run-other");
  cache.putCredentials(kept, "ANTHROPIC_API_KEY", { key: "sk", savedBase: null }, readAt);
  assert.equal(kept.credentials.size, 0, "keys read across an eviction are not kept either");
});
