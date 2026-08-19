import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnalytics, captureJobErrors, type Analytics } from "./analytics.js";
import { loadEnv } from "./env.js";

/** A key-shaped token and an unroutable host, so nothing ever sends. */
const FAKE_ENV = {
  POSTHOG_API_KEY: "phc_test_key_never_sent_anywhere",
  POSTHOG_HOST: "http://127.0.0.1:1",
};

test("no key means no analytics, quietly", () => {
  assert.equal(createAnalytics(loadEnv({})), null);
});

test("capture and captureException accept every identity shape without throwing", async () => {
  const analytics = createAnalytics(loadEnv(FAKE_ENV));
  assert.ok(analytics);
  // A user, an organization fallback, and the bare server fallback.
  analytics.capture({ event: "test event", userId: "user-1", organizationId: "org-1" });
  analytics.capture({ event: "test event", organizationId: "org-1" });
  analytics.capture({ event: "test event" });
  analytics.captureException(new Error("boom"), "user-1", "org-1", { path: "/x" });
  analytics.captureException("a string, not an Error");
  await analytics.shutdown();
});

test("shutdown removes the exception listeners autocapture installed", async () => {
  const exceptionsBefore = process.listeners("uncaughtException").length;
  const rejectionsBefore = process.listeners("unhandledRejection").length;
  const analytics = createAnalytics(loadEnv(FAKE_ENV));
  assert.ok(analytics);
  await analytics.shutdown();
  // Leaked listeners accumulate across the embedded TUI's restarts and
  // this very suite, and each is another handler racing to exit the
  // process on a crash.
  assert.equal(process.listeners("uncaughtException").length, exceptionsBefore);
  assert.equal(process.listeners("unhandledRejection").length, rejectionsBefore);
});

test("shutdown returns promptly when PostHog is unreachable", async () => {
  const analytics = createAnalytics(loadEnv(FAKE_ENV));
  assert.ok(analytics);
  analytics.capture({ event: "queued but never deliverable" });
  const began = Date.now();
  await analytics.shutdown();
  // The process's shutdown deadline is ten seconds; the flush must
  // give up well inside it rather than spending the SDK's default
  // thirty on a host that is not answering.
  assert.ok(Date.now() - began < 8000, "shutdown must not wait out the SDK's 30s default");
});

test("captureJobErrors reports the failure and still rethrows", async () => {
  const captured: Array<{ error: unknown; properties?: Record<string, unknown> }> = [];
  const analytics: Analytics = {
    capture: () => {},
    captureException: (error, _userId, _organizationId, properties) => {
      captured.push({ error, ...(properties ? { properties } : {}) });
    },
    shutdown: async () => {},
  };
  const wrapped = captureJobErrors(analytics, "test.queue", async () => {
    throw new Error("job failed");
  });
  await assert.rejects(wrapped(), /job failed/);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.properties?.queue, "test.queue");
});

test("captureJobErrors without analytics is a plain passthrough", async () => {
  let ran = false;
  await captureJobErrors(undefined, "test.queue", async () => {
    ran = true;
  })();
  assert.ok(ran);
});
