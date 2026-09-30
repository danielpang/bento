import assert from "node:assert/strict";
import test from "node:test";
import { UNBILLED_REASONS, unbilledReason, type UnbilledReason } from "./unbilled-reasons.js";

const FLY_OUTAGE = "sandbox provisioning failed: APIError: service temporarily unavailable, please retry";

test("reason ids are unique", () => {
  const ids = UNBILLED_REASONS.map((reason) => reason.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a Fly sprite outage is unbilled, including when stderr mentions a billed phrase", () => {
  assert.equal(unbilledReason(FLY_OUTAGE)?.id, "sprite-driver-error");
  assert.equal(
    unbilledReason(`${FLY_OUTAGE}\nuse the same checkout\nrequires agents to run without network access`)?.id,
    "sprite-driver-error",
  );
});

test("a sprite that was never acquired, and an exec handshake that died first, are unbilled", () => {
  assert.equal(
    unbilledReason("sandbox provisioning failed: could not acquire sprite bento-abc")?.id,
    "sprite-not-acquired",
  );
  assert.equal(
    unbilledReason("sandbox provisioning failed: sprite bento-abc was not created")?.id,
    "sprite-not-acquired",
  );
  assert.equal(
    unbilledReason(
      "sandbox provisioning failed: the sandbox exec connection failed before the command started (status 101) after 2 attempts",
    )?.id,
    "sprite-exec-handshake",
  );
});

test("work the agent already spent, and caller-caused provision failures, still count", () => {
  const billed = [
    "exec failed: Error: WebSocket closed",
    "opencode is not installed in this sandbox, so the agent never started. Its install did not finish, and the next run installs it again.",
    "sandbox provisioning failed: Repositories api and web use the same checkout. Remove one under Settings, Repositories, then run again.",
    "sandbox provisioning failed: This organization requires agents to run without network access, and this deployment has no restricted network configured.",
    "sandbox provisioning failed: provisioning script failed with exit code 128\nfatal: Authentication failed",
    "the tests failed",
    "interrupted by a server restart",
    "The agent hit the 120 minute run limit and was stopped. Send it a message to continue where it left off.",
  ];
  for (const error of billed) assert.equal(unbilledReason(error), null, error);
  assert.equal(unbilledReason(null), null);
});

test("a row added to the list is the reason that fires, and an exception on a later line does not", () => {
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
  assert.equal(
    unbilledReason("Sprite creation is rate limited. Waiting before trying again.\nalready on the clock", reasons)?.id,
    "rate-limited-sprite",
  );
  assert.equal(unbilledReason("Sprite creation is rate limited. Waiting before trying again."), null);
});

test("a pattern row matches, and an invalid pattern is rejected before any error is classified", () => {
  const added: UnbilledReason = {
    id: "typed-outage",
    summary: "Example pattern.",
    match: { kind: "pattern", text: "^boom: [A-Za-z]+Error:" },
  };
  assert.equal(unbilledReason("boom: APIError: down", [added])?.id, "typed-outage");
  assert.equal(unbilledReason("boom: APIError: down\nignore this APIError:", [added])?.id, "typed-outage");
  const broken: UnbilledReason = {
    id: "broken",
    summary: "Invalid on purpose.",
    match: { kind: "pattern", text: "(" },
  };
  assert.throws(() => unbilledReason("the tests failed", [broken]), /invalid pattern/);
  assert.throws(
    () => unbilledReason("the tests failed", [{ id: "empty", summary: "no", match: { kind: "prefix", text: "" } }]),
    /empty prefix/,
  );
});
