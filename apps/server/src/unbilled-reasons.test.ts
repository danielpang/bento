import assert from "node:assert/strict";
import test from "node:test";
import { UNBILLED_REASONS, unbilledReason, type UnbilledReason } from "./unbilled-reasons.js";

test("unbilled reason ids are unique", () => {
  const ids = UNBILLED_REASONS.map((reason) => reason.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("provider failures before a Sprite starts are not billed", () => {
  assert.equal(
    unbilledReason("sandbox provisioning failed: APIError: service temporarily unavailable")?.id,
    "sprite-driver-error",
  );
  assert.equal(
    unbilledReason("sandbox provisioning failed: could not acquire sprite bento-abc")?.id,
    "sprite-not-acquired",
  );
  assert.equal(
    unbilledReason(
      "sandbox provisioning failed: the sandbox exec connection failed before the command started (status 101)",
    )?.id,
    "sprite-exec-handshake",
  );
});

test("agent work and caller-caused provisioning failures remain billable", () => {
  const billed = [
    "exec failed: Error: WebSocket closed",
    "sandbox provisioning failed: Repositories api and web use the same checkout.",
    "sandbox provisioning failed: This organization requires agents to run without network access.",
    "sandbox provisioning failed: provisioning script failed with exit code 128\nfatal: Authentication failed",
    "the tests failed",
    "interrupted by a server restart",
  ];
  for (const error of billed) assert.equal(unbilledReason(error), null, error);
  assert.equal(unbilledReason(null), null);
});

test("only the opening line can classify a failure", () => {
  assert.equal(
    unbilledReason("sandbox provisioning failed: APIError: down\ncaller error text")?.id,
    "sprite-driver-error",
  );
  assert.equal(unbilledReason("caller error\nsandbox provisioning failed: APIError: down"), null);
});

test("additional rules support exceptions and reject invalid matches", () => {
  const added: UnbilledReason = {
    id: "rate-limited-sprite",
    summary: "Example extension.",
    match: { kind: "includes", text: "Sprite creation is rate limited" },
    except: [{ kind: "includes", text: "already on the clock" }],
  };
  assert.equal(unbilledReason("Sprite creation is rate limited", [added])?.id, added.id);
  assert.equal(unbilledReason("Sprite creation is rate limited but already on the clock", [added]), null);
  assert.throws(
    () => unbilledReason("anything", [{ id: "broken", summary: "broken", match: { kind: "pattern", text: "(" } }]),
    /invalid pattern/,
  );
  assert.throws(
    () => unbilledReason("anything", [{ id: "empty", summary: "empty", match: { kind: "prefix", text: "" } }]),
    /empty prefix/,
  );
});
