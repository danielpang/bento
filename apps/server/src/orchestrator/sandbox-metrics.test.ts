import assert from "node:assert/strict";
import test from "node:test";
import { recordingAnalytics } from "../test-analytics.js";
import {
  reportSandboxProvisioned,
  reportSandboxReady,
  runOwnerProperties,
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
    owner: { featureId: "feature-1" },
  });
  reportSandboxProvisioned(null, {
    provider: "sprite",
    selection: "auto",
    fellBackFrom: null,
    attempts: 1,
    projectId: "project-1",
    organizationId: null,
    userId: null,
    owner: { featureId: "feature-2" },
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
    owner: { swarmId: "swarm-1", swarmTaskId: "task-1" },
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
        owner: { featureId: "feature-1" },
      },
    ),
  );
});

test("every sandbox event names a run's board the same way", () => {
  assert.deepEqual(runOwnerProperties({ featureId: "feature-1" }), { feature_id: "feature-1" });
  assert.deepEqual(runOwnerProperties({ featureId: "feature-1" }, "stage-1"), {
    feature_id: "feature-1",
    stage_id: "stage-1",
  });
  assert.deepEqual(runOwnerProperties({ swarmId: "swarm-1" }), { swarm_id: "swarm-1" });
  assert.deepEqual(runOwnerProperties({ swarmId: "swarm-1", swarmTaskId: null }), { swarm_id: "swarm-1" });
  assert.deepEqual(runOwnerProperties({ swarmId: "swarm-1", swarmTaskId: "task-1" }), {
    swarm_id: "swarm-1",
    swarm_task_id: "task-1",
  });
});

test("what a provision did is the driver's answer first, and the owner's own row when it gave none", () => {
  // The driver found a running machine and reopened it, whatever the row said.
  assert.equal(sandboxOrigin({ createdSandbox: false, hadMachine: true }), "reused");
  assert.equal(sandboxOrigin({ createdSandbox: false, hadMachine: false }), "reused");
  // The driver made one for an owner that had none: a card's first
  // stage, a card whose machine was reaped, or a swarm worker's first
  // task, whose provider followed the planner's row.
  assert.equal(sandboxOrigin({ createdSandbox: true, hadMachine: false }), "new");
  assert.equal(sandboxOrigin({ createdSandbox: true }), "new");
  // The driver made one for an owner that had a machine: a hibernated
  // Modal snapshot restored, or a sprite that was gone.
  assert.equal(sandboxOrigin({ createdSandbox: true, hadMachine: true }), "restored");
  // A driver with no machine to speak of leaves the row to answer.
  assert.equal(sandboxOrigin({ hadMachine: true }), "reused");
  assert.equal(sandboxOrigin({ hadMachine: false }), "new");
  assert.equal(sandboxOrigin({}), "new");
});

test("a sandbox whose agent came up reports the wait from queueing, in slices on one clock", () => {
  const { analytics, events } = recordingAnalytics();

  reportSandboxReady(analytics, {
    runId: "run-1",
    role: "stage",
    provider: "sprite",
    selection: "auto",
    origin: "new",
    queueWaitMs: 2_500.4,
    sinceClaimMs: 87_499.6,
    provisionMs: 80_000.4,
    projectId: "project-1",
    organizationId: "org-1",
    userId: "user-1",
    owner: { featureId: "feature-1" },
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
    provider: "sprite",
    selection: "auto",
    role: "stage",
    run_id: "run-1",
    project_id: "project-1",
    feature_id: "feature-1",
    stage_id: "stage-1",
  });
});

test("a swarm's machine names its swarm, and a runner's leaves out what it did not say", () => {
  const { analytics, events } = recordingAnalytics();
  reportSandboxReady(analytics, {
    runId: "run-2",
    role: "worker",
    provider: "modal",
    selection: "existing",
    origin: "restored",
    queueWaitMs: 0,
    sinceClaimMs: 4_000,
    provisionMs: 3_000,
    projectId: "project-1",
    organizationId: null,
    userId: null,
    owner: { swarmId: "swarm-1", swarmTaskId: "task-1" },
  });
  reportSandboxReady(analytics, {
    runId: "run-3",
    role: "stage",
    provider: "runner",
    origin: "new",
    queueWaitMs: 10,
    sinceClaimMs: 20,
    projectId: "project-1",
    organizationId: null,
    userId: "user-1",
    owner: { featureId: "feature-1" },
    stageId: "stage-1",
  });
  assert.equal(events.length, 2);
  assert.equal(events[0]?.userId, null);
  assert.deepEqual(events[0]?.properties, {
    duration_ms: 4_000,
    queue_wait_ms: 0,
    provision_ms: 3_000,
    sandbox_origin: "restored",
    provider: "modal",
    selection: "existing",
    role: "worker",
    run_id: "run-2",
    project_id: "project-1",
    swarm_id: "swarm-1",
    swarm_task_id: "task-1",
  });
  assert.deepEqual(events[1]?.properties, {
    duration_ms: 30,
    queue_wait_ms: 10,
    sandbox_origin: "new",
    provider: "runner",
    role: "stage",
    run_id: "run-3",
    project_id: "project-1",
    feature_id: "feature-1",
    stage_id: "stage-1",
  });
});

test("a clock that went backwards never reports a negative wait, and a throw stays inside", () => {
  const { analytics, events } = recordingAnalytics();
  reportSandboxReady(analytics, {
    runId: "run-4",
    role: "stage",
    provider: "sprite",
    origin: "new",
    queueWaitMs: -10_000,
    sinceClaimMs: Number.NaN,
    provisionMs: -5,
    projectId: "project-1",
    organizationId: null,
    userId: null,
    owner: { featureId: "feature-1" },
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
        runId: "run-5",
        role: "stage",
        provider: "sprite",
        origin: "new",
        queueWaitMs: 1,
        sinceClaimMs: 1,
        projectId: "project-1",
        organizationId: null,
        userId: null,
        owner: { featureId: "feature-1" },
      },
    ),
  );
});
