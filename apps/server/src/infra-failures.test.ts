import assert from "node:assert/strict";
import test from "node:test";
import { SWARM_BRANCH_LOST_MESSAGE, INFRA_FAILURE_REASONS, infraFailureReason, type InfraFailureReason } from "./infra-failures.js";

test("infra failure ids are unique", () => {
  const ids = INFRA_FAILURE_REASONS.map((reason) => reason.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("sandbox and restart failures are recognised from the record's opening line", () => {
  assert.equal(
    infraFailureReason(
      "sandbox provisioning failed: Sandbox failed to provision, we're investigating the issue. Please try again later.",
    )?.id,
    "sandbox-unavailable",
  );
  assert.equal(
    infraFailureReason("sandbox provisioning failed: APIError: service temporarily unavailable")?.id,
    "sprite-driver-error",
  );
  assert.equal(
    infraFailureReason("sandbox provisioning failed: could not acquire sprite bento-abc")?.id,
    "sprite-not-acquired",
  );
  assert.equal(
    infraFailureReason(
      "sandbox provisioning failed: the sandbox exec connection failed before the command started (status 101)",
    )?.id,
    "sprite-exec-handshake",
  );
  assert.equal(
    infraFailureReason(
      "The sandbox did not accept the command that starts the agent, so codex never ran. Run again to try a new connection.",
    )?.id,
    "sandbox-exec-refused",
  );
  assert.equal(
    infraFailureReason("The sandbox for this run no longer exists, so codex never ran. Run again to provision a new sandbox.")?.id,
    "sandbox-gone",
  );
  assert.equal(
    infraFailureReason("The sandbox stopped responding before the agent started, so no agent ran.")?.id,
    "sandbox-stalled",
  );
  assert.equal(
    infraFailureReason(
      "An agent from an earlier run of this task is still running in its sandbox and could not be stopped, so a second agent was not started beside it.",
    )?.id,
    "previous-agent-running",
  );
  assert.equal(
    infraFailureReason("The sandbox stopped while the agent was running, so the run ended. Run again to continue.")?.id,
    "sandbox-stopped",
  );
  assert.equal(infraFailureReason("Bento restarted before the agent started, so no agent ran.")?.id, "restart-before-agent");
  assert.equal(infraFailureReason("interrupted by a server restart"), null, "a restart that cut off a working agent is the planner's to judge");
  assert.equal(infraFailureReason(SWARM_BRANCH_LOST_MESSAGE)?.id, "swarm-branch-lost");
});

test("agent work and caller-caused provisioning failures are not infra failures", () => {
  const work = [
    "exec failed: Error: WebSocket closed",
    "sandbox provisioning failed: Repositories api and web use the same checkout.",
    "sandbox provisioning failed: This organization requires agents to run without network access.",
    "sandbox provisioning failed: provisioning script failed with exit code 128\nfatal: Authentication failed",
    "the tests failed",
    "interrupted by a server restart",
  ];
  for (const error of work) assert.equal(infraFailureReason(error), null, error);
  assert.equal(infraFailureReason(null), null);
});

test("only the opening line can classify a failure", () => {
  assert.equal(
    infraFailureReason("sandbox provisioning failed: APIError: down\ncaller error text")?.id,
    "sprite-driver-error",
  );
  assert.equal(infraFailureReason("caller error\nsandbox provisioning failed: APIError: down"), null);
});

test("additional rules support exceptions and reject invalid matches", () => {
  const added: InfraFailureReason = {
    id: "rate-limited-sprite",
    summary: "Example extension.",
    match: { kind: "includes", text: "Sprite creation is rate limited" },
    except: [{ kind: "includes", text: "already on the clock" }],
  };
  assert.equal(infraFailureReason("Sprite creation is rate limited", [added])?.id, added.id);
  assert.equal(infraFailureReason("Sprite creation is rate limited but already on the clock", [added]), null);
  assert.throws(
    () => infraFailureReason("anything", [{ id: "broken", summary: "broken", match: { kind: "pattern", text: "(" } }]),
    /invalid pattern/,
  );
  assert.throws(
    () => infraFailureReason("anything", [{ id: "empty", summary: "empty", match: { kind: "prefix", text: "" } }]),
    /empty prefix/,
  );
});

test("a usage limit is not an infra failure", () => {
  assert.equal(infraFailureReason("You've hit your session limit · resets 7:30pm (UTC)"), null);
  assert.equal(infraFailureReason("Claude AI usage limit reached|1760558400"), null);
});
