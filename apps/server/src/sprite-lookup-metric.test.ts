import assert from "node:assert/strict";
import test from "node:test";
import type { Analytics } from "./analytics.js";
import { reportSpriteLookupRetry, SPRITE_LOOKUP_RETRIED_EVENT } from "./context.js";

test("a sprite lookup retry is one PostHog event with the count and how it ended", () => {
  const captured: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  const analytics: Analytics = {
    capture(event) {
      captured.push(event);
    },
    captureException() {},
    async shutdown() {},
  };

  reportSpriteLookupRetry(analytics, {
    name: "bento-feature",
    retries: 2,
    outcome: "recovered",
    reason: "not_found",
  });
  reportSpriteLookupRetry(null, {
    name: "bento-feature",
    retries: 5,
    outcome: "addressed_by_name",
    reason: "not_found",
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.event, SPRITE_LOOKUP_RETRIED_EVENT);
  assert.equal(captured[0]?.event, "sprite lookup retried");
  assert.deepEqual(captured[0]?.properties, {
    sprite: "bento-feature",
    retries: 2,
    outcome: "recovered",
    reason: "not_found",
  });
});

test("a metric that throws does not escape the reporter", () => {
  const analytics: Analytics = {
    capture() {
      throw new Error("posthog is down");
    },
    captureException() {},
    async shutdown() {},
  };
  assert.doesNotThrow(() =>
    reportSpriteLookupRetry(analytics, {
      name: "bento-feature",
      retries: 1,
      outcome: "failed",
      reason: "transient",
    }),
  );
});
