import { test } from "node:test";
import assert from "node:assert/strict";
import { bindWaitlistCapture } from "./waitlist-cloud-capture.js";
import { recordingAnalytics } from "./test-analytics.js";

test("bindWaitlistCapture is undefined without analytics", () => {
  assert.equal(bindWaitlistCapture(null), undefined);
});

test("bindWaitlistCapture forwards waitlist operator events to PostHog", () => {
  const { analytics, events } = recordingAnalytics();
  const capture = bindWaitlistCapture(analytics);
  assert.ok(capture);
  capture({ event: "waitlist invited", properties: { wave_id: "w1" } });
  assert.deepEqual(events, [{ event: "waitlist invited", properties: { wave_id: "w1" } }]);
});
