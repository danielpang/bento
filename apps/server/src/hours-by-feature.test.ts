import assert from "node:assert/strict";
import test from "node:test";
import { hoursByFeature, runHoursInPeriod } from "./hours-by-feature.js";

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
