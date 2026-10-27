import assert from "node:assert/strict";
import test from "node:test";
import { bucketUnitFor, MAX_CUSTOM_DAYS, resolveAnalyticsWindow } from "./project-analytics.js";

const now = new Date("2026-10-27T14:05:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function window(query: Parameters<typeof resolveAnalyticsWindow>[0]) {
  const resolved = resolveAnalyticsWindow(query, now);
  assert.ok("window" in resolved, `expected a window, got ${JSON.stringify(resolved)}`);
  return resolved.window;
}

function refusal(query: Parameters<typeof resolveAnalyticsWindow>[0]) {
  const resolved = resolveAnalyticsWindow(query, now);
  assert.ok("error" in resolved, `expected a refusal, got ${JSON.stringify(resolved)}`);
  return resolved.error;
}

test("nothing asked for is the last month, to this minute", () => {
  const w = window({});
  assert.equal(w.range, "1m");
  assert.equal(w.to.getTime(), now.getTime());
  assert.equal(w.from.getTime(), now.getTime() - 30 * DAY);
  assert.equal(w.bucketUnit, "day");
});

test("each preset is a span back from now, bucketed to stay readable", () => {
  assert.equal(window({ range: "3d" }).from.getTime(), now.getTime() - 3 * DAY);
  assert.equal(window({ range: "3d" }).bucketUnit, "6h", "three days are twelve quarter days, not three bars");
  assert.equal(window({ range: "1w" }).from.getTime(), now.getTime() - 7 * DAY);
  assert.equal(window({ range: "1w" }).bucketUnit, "day");
  assert.equal(window({ range: "2w" }).from.getTime(), now.getTime() - 14 * DAY);
  assert.match(refusal({ range: "1y" }), /range must be one of/);
});

test("a custom window is two UTC dates, the last one included, and wins over a preset", () => {
  const w = window({ range: "3d", from: "2026-09-01", to: "2026-09-30" });
  assert.equal(w.range, "custom");
  assert.equal(w.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(w.to.toISOString(), "2026-10-01T00:00:00.000Z", "Sep 30 is inside, so the window closes at Oct 1");
  assert.equal(w.bucketUnit, "day");
  const day = window({ from: "2026-10-27", to: "2026-10-27" });
  assert.equal(day.to.getTime() - day.from.getTime(), DAY, "one date is one day");
});

test("a custom window is refused when it is not one", () => {
  assert.match(refusal({ from: "2026-09-01" }), /both from and to/);
  assert.match(refusal({ to: "2026-09-01" }), /both from and to/);
  assert.match(refusal({ from: "2026-02-30", to: "2026-03-01" }), /YYYY-MM-DD/, "Feb 30 does not round trip");
  assert.match(refusal({ from: "09/01/2026", to: "2026-09-30" }), /YYYY-MM-DD/);
  assert.match(refusal({ from: "2026-09-30", to: "2026-09-01" }), /on or after/);
  assert.match(refusal({ from: "2026-11-01", to: "2026-11-02" }), /future/);
  assert.match(refusal({ from: "2020-01-01", to: "2026-10-27" }), new RegExp(`${MAX_CUSTOM_DAYS} days`));
});

test("longer windows get coarser buckets", () => {
  assert.equal(bucketUnitFor(3 * DAY), "6h");
  assert.equal(bucketUnitFor(4 * DAY), "day");
  assert.equal(bucketUnitFor(62 * DAY), "day");
  assert.equal(bucketUnitFor(63 * DAY), "week");
  assert.equal(bucketUnitFor(372 * DAY), "week");
  assert.equal(bucketUnitFor(373 * DAY), "month");
});
