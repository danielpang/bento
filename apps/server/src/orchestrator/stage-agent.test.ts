import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpSource, type FollowUpWorkRun } from "./stage-agent.js";

const qa: FollowUpWorkRun = {
  stageId: "stage-qa",
  agentProfileId: "agent-qa",
  cliSessionId: "qa-sess",
  executor: "server",
};

const impl = {
  stageId: "stage-impl",
  agentProfileId: "agent-impl",
};

/**
 * Send-back is a stage change. The last work run is still the agent
 * that just ran (QA), and inheriting its profile and session is how
 * the Implementation or Code Review agent never got the card back.
 */
test("a follow-up after a stage change uses the destination stage's agent", () => {
  const source = followUpSource({
    currentStageId: impl.stageId,
    assignedAgentProfileId: impl.agentProfileId,
    lastWorkRun: qa,
  });
  assert.equal(source.agentProfileId, impl.agentProfileId);
  assert.equal(source.stageId, impl.stageId);
  assert.equal(source.cliSessionId, null, "a different agent cannot resume the previous session");
});

test("a follow-up on the same stage resumes the last work agent's session", () => {
  const source = followUpSource({
    currentStageId: qa.stageId,
    assignedAgentProfileId: qa.agentProfileId,
    lastWorkRun: qa,
  });
  assert.equal(source.agentProfileId, qa.agentProfileId);
  assert.equal(source.cliSessionId, "qa-sess");
});

test("a follow-up on a stage with no assigned agent still leaves the previous session behind", () => {
  const source = followUpSource({
    currentStageId: impl.stageId,
    assignedAgentProfileId: null,
    lastWorkRun: qa,
  });
  assert.equal(source.stageId, impl.stageId);
  assert.equal(source.agentProfileId, qa.agentProfileId, "no pipeline agent: keep whoever last worked");
  assert.equal(source.cliSessionId, null, "but do not resume a session from another stage");
});

test("a follow-up from the backlog keeps the last work conversation", () => {
  const source = followUpSource({
    currentStageId: null,
    assignedAgentProfileId: null,
    lastWorkRun: qa,
  });
  assert.deepEqual(source, qa);
});
