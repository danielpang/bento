import { test } from "node:test";
import assert from "node:assert/strict";
import { asPipelineRun, isPipelineRun, type AgentRunRow } from "./pipeline-run.js";

/**
 * The narrowing every card path now goes through. Worth its own test
 * because deleting the per-site checks only pays off if this one is
 * right: it is the single place a swarm run is turned away from the
 * pipeline.
 */
function row(overrides: Partial<AgentRunRow>): AgentRunRow {
  return {
    id: "run-1",
    type: "pipeline",
    featureId: "feature-1",
    stageId: "stage-1",
    swarmId: null,
    swarmTaskId: null,
    organizationId: null,
    agentProfileId: "profile-1",
    role: "stage",
    kind: "task",
    ...overrides,
  } as AgentRunRow;
}

test("a card's run narrows to a pipeline run", () => {
  const run = row({});
  assert.equal(isPipelineRun(run), true);
  assert.equal(asPipelineRun(run).featureId, "feature-1");
});

test("a swarm's run is not a pipeline run", () => {
  const run = row({ type: "swarm", featureId: null, stageId: null, swarmId: "swarm-1", role: "worker" });
  assert.equal(isPipelineRun(run), false);
});

test("asPipelineRun says which run and which board it was", () => {
  // Loud on purpose: reaching it means something put a swarm run on a
  // pipeline queue, and returning quietly would leave that run parked
  // forever with nothing reporting why.
  const run = row({ id: "run-9", type: "swarm", featureId: null, stageId: null, swarmId: "swarm-1", role: "planner" });
  assert.throws(() => asPipelineRun(run), /run run-9 is a swarm run, not a pipeline run/);
});

test("a row whose discriminator disagrees with its columns is refused", () => {
  // The database will not store one (agent_runs_pipeline_shape), so
  // this is about the guard being a guard rather than a cast: it reads
  // the columns it promises, not only the label.
  assert.equal(isPipelineRun(row({ featureId: null })), false);
  assert.equal(isPipelineRun(row({ stageId: null })), false);
});
