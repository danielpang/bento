import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_KEYS } from "./Setup.js";

test("setup hub status puts Vercel AI Gateway last", () => {
  const names = PROVIDER_KEYS.map((provider) => provider.name);
  assert.equal(names.at(-1), "AI_GATEWAY_API_KEY");
  assert.equal(PROVIDER_KEYS.find((provider) => provider.name === "AI_GATEWAY_API_KEY")?.label, "Vercel AI Gateway");
});
