import assert from "node:assert/strict";
import test from "node:test";
import { captureException, identifyUser, resetUser } from "./posthog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

test("capture and identify are no-ops before the client starts", () => {
  captureException(new Error("boom"), { source: "test" });
  captureException("a string, not an Error");
  identifyUser("user-1", { email: "a@b.test", name: "A" });
  resetUser();
});

test("ErrorBoundary keeps the thrown error for the fallback", () => {
  const state = ErrorBoundary.getDerivedStateFromError(new Error("render failed"));
  assert.equal(state.error.message, "render failed");
});
