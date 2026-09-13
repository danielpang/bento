import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_TABS } from "./components/Credentials.js";

test("Model provider keys includes Vercel AI Gateway after OpenRouter", () => {
  const ids = PROVIDER_TABS.map((tab) => tab.id);
  assert.ok(ids.includes("vercel"), "the Gateway tab is in the strip");
  assert.equal(ids[ids.indexOf("openrouter") + 1], "vercel");
  const gateway = PROVIDER_TABS.find((tab) => tab.id === "vercel");
  assert.deepEqual(gateway, {
    id: "vercel",
    label: "Vercel AI Gateway",
    keys: ["AI_GATEWAY_API_KEY"],
  });
});
