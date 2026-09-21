import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_PERSISTENCE,
  captureException,
  identifyUser,
  resetUser,
  sessionIdentityChange,
  shouldStartErrorTracking,
} from "./posthog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

test("capture and identify are safe before the client starts", () => {
  captureException(new Error("boom"), { source: "test" });
  captureException("a string, not an Error");
  identifyUser("user-1", { email: "a@b.test", name: "A" });
  resetUser();
});

test("browser persistence shares the marketing cookie across subdomains", () => {
  assert.equal(BROWSER_PERSISTENCE.persistence, "localStorage+cookie");
  assert.equal(BROWSER_PERSISTENCE.cross_subdomain_cookie, true);
  assert.equal(BROWSER_PERSISTENCE.cookieWinsOnConflict, true);
});

test("an anonymous marketing hop does not reset identity", () => {
  assert.deepEqual(sessionIdentityChange(null, null), { type: "none" });
});

test("a signed-in session identifies the better-auth user", () => {
  const user = { id: "user-1", email: "a@b.test", name: "A" };
  assert.deepEqual(sessionIdentityChange(null, user), { type: "identify", user });
});

test("sign out after identify resets so the next person is not aliased", () => {
  assert.deepEqual(sessionIdentityChange("user-1", null), { type: "reset" });
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
