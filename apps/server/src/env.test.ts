import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, posthogApiKey } from "./env.js";

test("posthogApiKey is null when the key is unset", () => {
  assert.equal(posthogApiKey(loadEnv({ BENTO_MODE: "multi" })), null);
  assert.equal(posthogApiKey(loadEnv({})), null);
});

test("posthogApiKey is null in local mode even with a leftover key", () => {
  assert.equal(
    posthogApiKey(loadEnv({ BENTO_MODE: "local", POSTHOG_API_KEY: "phc_leftover_from_hosted" })),
    null,
  );
});

test("posthogApiKey is null for whitespace-only keys", () => {
  assert.equal(posthogApiKey(loadEnv({ BENTO_MODE: "multi", POSTHOG_API_KEY: "   " })), null);
});

test("posthogApiKey returns the trimmed token in multi mode", () => {
  assert.equal(
    posthogApiKey(loadEnv({ BENTO_MODE: "multi", POSTHOG_API_KEY: "  phc_real  " })),
    "phc_real",
  );
});
