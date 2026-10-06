import assert from "node:assert/strict";
import test from "node:test";
import { recordingAnalytics } from "../test-analytics.js";
import {
  reportSandboxProvisioned,
  reportSandboxReady,
  sandboxOrigin,
  SANDBOX_PROVISIONED_EVENT,
  SANDBOX_READY_EVENT,
} from "./sandbox-metrics.js";

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

test("a sandbox that reached its agent reports the wait from the stage move, in slices", () => {
  const { analytics, events } = recordingAnalytics();
  const queuedAt = new Date("2026-10-06T10:00:00.000Z");
  const claimedAt = new Date("2026-10-06T10:00:02.500Z");
  const agentStartedAt = new Date("2026-10-06T10:01:30.000Z");

  reportSandboxReady(analytics, {
    runId: "run-1",
    provider: "sprite",
    selection: "auto",
    queuedAt,
    claimedAt,
    agentStartedAt,
    provisionMs: 80_000.4,
    projectId: "project-1",
    organizationId: "org-1",
    userId: "user-1",
    featureId: "feature-1",
    stageId: "stage-1",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, SANDBOX_READY_EVENT);
  assert.equal(events[0]?.event, "sandbox ready");
  assert.equal(events[0]?.userId, "user-1");
  assert.equal(events[0]?.organizationId, "org-1");
  assert.deepEqual(events[0]?.properties, {
    duration_ms: 90_000,
    queue_wait_ms: 2_500,
    provision_ms: 80_000,
    sandbox_origin: "new",
    sandbox_reused: false,
    provider: "sprite",
    selection: "auto",
    run_id: "run-1",
    project_id: "project-1",
    feature_id: "feature-1",
    stage_id: "stage-1",
  });
});

test("a machine the card already had is reported as reused, and a swarm names its swarm", () => {
  const { analytics, events } = recordingAnalytics();
  const queuedAt = new Date("2026-10-06T10:00:00.000Z");
  reportSandboxReady(analytics, {
    runId: "run-2",
    provider: "modal",
    selection: "existing",
    queuedAt,
    claimedAt: queuedAt,
    agentStartedAt: new Date(queuedAt.getTime() + 4_000),
    provisionMs: 3_000,
    projectId: "project-1",
    organizationId: null,
    userId: null,
    swarmId: "swarm-1",
    swarmTaskId: "task-1",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.userId, null);
  assert.deepEqual(events[0]?.properties, {
    duration_ms: 4_000,
    queue_wait_ms: 0,
    provision_ms: 3_000,
    sandbox_origin: "reused",
    sandbox_reused: true,
    provider: "modal",
    selection: "existing",
    run_id: "run-2",
    project_id: "project-1",
    swarm_id: "swarm-1",
    swarm_task_id: "task-1",
  });
  assert.equal(sandboxOrigin("existing"), "reused");
  assert.equal(sandboxOrigin("auto"), "new");
  assert.equal(sandboxOrigin("project"), "new");
  assert.equal(sandboxOrigin("default"), "new");
});

test("a clock that went backwards never reports a negative wait, and a throw stays inside", () => {
  const { analytics, events } = recordingAnalytics();
  const later = new Date("2026-10-06T10:00:10.000Z");
  const earlier = new Date("2026-10-06T10:00:00.000Z");
  reportSandboxReady(analytics, {
    runId: "run-3",
    provider: "sprite",
    selection: "auto",
    queuedAt: later,
    claimedAt: earlier,
    agentStartedAt: earlier,
    provisionMs: -5,
    projectId: "project-1",
    organizationId: null,
    userId: null,
  });
  assert.equal(events[0]?.properties?.duration_ms, 0);
  assert.equal(events[0]?.properties?.queue_wait_ms, 0);
  assert.equal(events[0]?.properties?.provision_ms, 0);

  assert.doesNotThrow(() =>
    reportSandboxReady(
      {
        capture() {
          throw new Error("posthog is down");
        },
        captureException() {},
        async shutdown() {},
      },
      {
        runId: "run-4",
        provider: "sprite",
        selection: "auto",
        queuedAt: earlier,
        claimedAt: earlier,
        agentStartedAt: later,
        provisionMs: 1,
        projectId: "project-1",
        organizationId: null,
        userId: null,
      },
    ),
  );
});
