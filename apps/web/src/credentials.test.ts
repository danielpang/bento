import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_TABS } from "./provider-tabs.js";

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
