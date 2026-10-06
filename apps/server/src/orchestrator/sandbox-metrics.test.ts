import assert from "node:assert/strict";
import test from "node:test";
import { recordingAnalytics } from "../test-analytics.js";
import { reportSandboxProvisioned, SANDBOX_PROVISIONED_EVENT } from "./sandbox-metrics.js";

test("a provisioned sandbox is one PostHog event naming the provider and whether it was a fallback", () => {
  const { analytics, events } = recordingAnalytics();

  reportSandboxProvisioned(analytics, {
    provider: "modal",
    selection: "auto",
    fellBackFrom: "sprite",
    attempts: 2,
    projectId: "project-1",
    organizationId: "org-1",
    userId: "user-1",
    featureId: "feature-1",
  });
  reportSandboxProvisioned(null, {
    provider: "sprite",
    selection: "auto",
    fellBackFrom: null,
    attempts: 1,
    projectId: "project-1",
    organizationId: null,
    userId: null,
    featureId: "feature-2",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, SANDBOX_PROVISIONED_EVENT);
  assert.equal(events[0]?.event, "sandbox provisioned");
  assert.equal(events[0]?.userId, "user-1");
  assert.equal(events[0]?.organizationId, "org-1");
  assert.deepEqual(events[0]?.properties, {
    provider: "modal",
    selection: "auto",
    fell_back_from: "sprite",
    fell_back: true,
    attempts: 2,
    project_id: "project-1",
    feature_id: "feature-1",
  });
});

test("a sprite that answered first is counted as no fallback, and a swarm names its swarm", () => {
  const { analytics, events } = recordingAnalytics();
  reportSandboxProvisioned(analytics, {
    provider: "sprite",
    selection: "auto",
    fellBackFrom: null,
    attempts: 1,
    projectId: "project-1",
    organizationId: null,
    userId: null,
    swarmId: "swarm-1",
    swarmTaskId: "task-1",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.userId, null);
  assert.deepEqual(events[0]?.properties, {
    provider: "sprite",
    selection: "auto",
    fell_back_from: null,
    fell_back: false,
    attempts: 1,
    project_id: "project-1",
    swarm_id: "swarm-1",
    swarm_task_id: "task-1",
  });
});

test("a metric that throws does not escape the reporter", () => {
  assert.doesNotThrow(() =>
    reportSandboxProvisioned(
      {
        capture() {
          throw new Error("posthog is down");
        },
        captureException() {},
        async shutdown() {},
      },
      {
        provider: "sprite",
        selection: "default",
        fellBackFrom: null,
        attempts: 1,
        projectId: "project-1",
        organizationId: null,
        userId: null,
      },
    ),
  );
});
