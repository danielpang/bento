import assert from "node:assert/strict";
import test from "node:test";
import { captureException, identifyUser, resetUser, shouldStartErrorTracking } from "./posthog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

test("capture and identify are no-ops before the client starts", () => {
  captureException(new Error("boom"), { source: "test" });
  captureException("a string, not an Error");
  identifyUser("user-1", { email: "a@b.test", name: "A" });
  resetUser();
});

test("shouldStartErrorTracking is off in local mode and without a key", () => {
  assert.equal(shouldStartErrorTracking({ mode: "local" }), false);
  assert.equal(
    shouldStartErrorTracking({ mode: "local", posthog: { apiKey: "phc_leftover_from_hosted" } }),
    false,
  );
  assert.equal(shouldStartErrorTracking({ mode: "multi" }), false);
  assert.equal(shouldStartErrorTracking({ mode: "multi", posthog: { apiKey: "   " } }), false);
  assert.equal(shouldStartErrorTracking({ mode: "multi", posthog: { apiKey: "phc_real" } }), true);
});

test("ErrorBoundary keeps the thrown error for the fallback", () => {
  const state = ErrorBoundary.getDerivedStateFromError(new Error("render failed"));
  assert.equal(state.error.message, "render failed");
});
