import assert from "node:assert/strict";
import test from "node:test";
import { UNBILLED_REASONS, unbilledReason, type UnbilledReason } from "./unbilled-reasons.js";

test("reason ids are unique", () => {
  const ids = UNBILLED_REASONS.map((reason) => reason.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a Fly sprite outage names the provision reason", () => {
  assert.equal(
    unbilledReason("sandbox provisioning failed: APIError: service temporarily unavailable, please retry")?.id,
    "sprite-provision",
  );
});

test("an exec throw and a missing CLI are their own reasons", () => {
  assert.equal(unbilledReason("exec failed: Error: WebSocket closed")?.id, "exec-failed");
  assert.equal(
    unbilledReason(
      "opencode is not installed in this sandbox, so the agent never started. Its install did not finish, and the next run installs it again.",
    )?.id,
    "cli-not-installed",
  );
});

test("caller configuration, agent failures, timeouts, and restarts still count", () => {
  const billed = [
    "sandbox provisioning failed: Repositories api and web use the same checkout. Remove one under Settings, Repositories, then run again.",
    "sandbox provisioning failed: This organization requires agents to run without network access, and this deployment has no restricted network configured.",
    "the tests failed",
    "interrupted by a server restart",
    "The agent hit the 120 minute run limit and was stopped. Send it a message to continue where it left off.",
  ];
  for (const error of billed) assert.equal(unbilledReason(error), null, error);
  assert.equal(unbilledReason(null), null);
});

test("a row added to the list is the reason that fires, and its exception still counts", () => {
  const added: UnbilledReason = {
    id: "rate-limited-sprite",
    summary: "Example of the row a new outage needs.",
    match: { kind: "includes", text: "Sprite creation is rate limited" },
    except: [{ kind: "includes", text: "already on the clock" }],
  };
  const reasons = [added, ...UNBILLED_REASONS];
  assert.equal(
    unbilledReason("Sprite creation is rate limited. Waiting before trying again.", reasons)?.id,
    "rate-limited-sprite",
  );
  assert.equal(
    unbilledReason("Sprite creation is rate limited, but this one is already on the clock.", reasons),
    null,
  );
  assert.equal(unbilledReason("Sprite creation is rate limited. Waiting before trying again."), null);
});
