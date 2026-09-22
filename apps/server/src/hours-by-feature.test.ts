import assert from "node:assert/strict";
import test from "node:test";
import { hoursByFeature, isInfrastructureFailure, runHoursInPeriod } from "./hours-by-feature.js";

const start = new Date("2026-09-01T00:00:00.000Z");
const end = new Date("2026-10-01T00:00:00.000Z");

test("a run fully inside the period counts its whole length", () => {
  const hours = runHoursInPeriod(
    new Date("2026-09-10T12:00:00.000Z"),
    new Date("2026-09-10T14:00:00.000Z"),
    start,
    end,
  );
  assert.equal(hours, 2);
});

test("a run that started last period only counts the overlap", () => {
  const hours = runHoursInPeriod(
    new Date("2026-08-31T22:00:00.000Z"),
    new Date("2026-09-01T03:00:00.000Z"),
    start,
    end,
  );
  assert.equal(hours, 3);
});

test("a run outside the period counts nothing", () => {
  assert.equal(
    runHoursInPeriod(
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-01T04:00:00.000Z"),
      start,
      end,
    ),
    0,
  );
});

test("a still-running run is clipped to now", () => {
  const now = new Date("2026-09-15T02:00:00.000Z");
  const hours = runHoursInPeriod(new Date("2026-09-15T00:00:00.000Z"), null, start, end, now);
  assert.equal(hours, 2);
});

test("a run with no start is not hours", () => {
  assert.equal(runHoursInPeriod(null, new Date("2026-09-15T00:00:00.000Z"), start, end), 0);
});

test("hours by feature sums runs on the same card and drops empty ones", () => {
  const rows = hoursByFeature(
    [
      {
        featureId: "a",
        title: "Rate limit",
        startedAt: new Date("2026-09-10T12:00:00.000Z"),
        endedAt: new Date("2026-09-10T14:00:00.000Z"),
      },
      {
        featureId: "a",
        title: "Rate limit",
        startedAt: new Date("2026-09-11T00:00:00.000Z"),
        endedAt: new Date("2026-09-11T01:00:00.000Z"),
      },
      {
        featureId: "b",
        title: "Login polish",
        startedAt: new Date("2026-09-12T00:00:00.000Z"),
        endedAt: new Date("2026-09-12T00:30:00.000Z"),
      },
      {
        featureId: "c",
        title: "Idle",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        endedAt: new Date("2026-08-01T04:00:00.000Z"),
      },
    ],
    start,
    end,
  );
  const byId = Object.fromEntries(rows.map((row) => [row.featureId, row]));
  assert.equal(byId.a?.agentHours, 3);
  assert.equal(byId.b?.agentHours, 0.5);
  assert.equal(byId.c, undefined);
});

test("a Fly sprite outage is an infrastructure failure, and a task failure is not", () => {
  assert.equal(
    isInfrastructureFailure(
      "sandbox provisioning failed: APIError: service temporarily unavailable, please retry",
    ),
    true,
  );
  assert.equal(isInfrastructureFailure("exec failed: Error: WebSocket closed"), true);
  assert.equal(
    isInfrastructureFailure(
      "opencode is not installed in this sandbox, so the agent never started. Its install did not finish, and the next run installs it again.",
    ),
    true,
  );
  assert.equal(
    isInfrastructureFailure(
      "sandbox provisioning failed: Repositories api and web use the same checkout. Remove one under Settings, Repositories, then run again.",
    ),
    false,
  );
  assert.equal(
    isInfrastructureFailure(
      "sandbox provisioning failed: This organization requires agents to run without network access, and this deployment has no restricted network configured.",
    ),
    false,
  );
  assert.equal(isInfrastructureFailure("the tests failed"), false);
  assert.equal(isInfrastructureFailure("interrupted by a server restart"), false);
  assert.equal(
    isInfrastructureFailure(
      "The agent hit the 120 minute run limit and was stopped. Send it a message to continue where it left off.",
    ),
    false,
  );
  assert.equal(isInfrastructureFailure(null), false);
});

test("a sprite that failed to start does not add agent hours", () => {
  const rows = hoursByFeature(
    [
      {
        featureId: "a",
        title: "Rate limit",
        startedAt: new Date("2026-09-10T12:00:00.000Z"),
        endedAt: new Date("2026-09-10T14:00:00.000Z"),
        error: "sandbox provisioning failed: APIError: service temporarily unavailable, please retry",
      },
      {
        featureId: "a",
        title: "Rate limit",
        startedAt: new Date("2026-09-11T00:00:00.000Z"),
        endedAt: new Date("2026-09-11T01:00:00.000Z"),
        error: "the agent could not apply the patch",
      },
    ],
    start,
    end,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.agentHours, 1);
});
