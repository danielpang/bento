import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_TABS, hasProviderKey } from "./provider-tabs.js";

test("Model provider keys puts Vercel AI Gateway last", () => {
  const ids = PROVIDER_TABS.map((tab) => tab.id);
  assert.equal(ids.at(-1), "vercel");
  const gateway = PROVIDER_TABS.find((tab) => tab.id === "vercel");
  assert.deepEqual(gateway, {
    id: "vercel",
    label: "Vercel AI Gateway",
    keys: ["AI_GATEWAY_API_KEY"],
  });
});

test("the onboarding provider step counts an API key, not a base URL alone", () => {
  assert.equal(hasProviderKey(["ANTHROPIC_API_KEY"]), true);
  assert.equal(hasProviderKey(["OPENROUTER_API_KEY", "GITHUB_TOKEN"]), true);
  assert.equal(hasProviderKey(["ANTHROPIC_BASE_URL", "GITHUB_TOKEN"]), false);
  assert.equal(hasProviderKey([]), false);
});
