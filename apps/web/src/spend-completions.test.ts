import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  axisIndices,
  axisLabel,
  bucketLabel,
  completionScale,
  windowPhrase,
} from "./components/completions-format.js";
import { SpendCompletions } from "./components/SpendCompletions.js";

test("the y axis ceiling is a clean number at or above the tallest bar", () => {
  assert.equal(completionScale(0), 1, "an empty chart still has a top line");
  assert.equal(completionScale(1), 1);
  assert.equal(completionScale(3), 4, "even below ten, so the midpoint is a whole number");
  assert.equal(completionScale(10), 10);
  assert.equal(completionScale(11), 20);
  assert.equal(completionScale(47), 50);
  assert.equal(completionScale(101), 150);
});

test("bucket labels are formatted in UTC, matching the bucket boundaries", () => {
  assert.equal(bucketLabel("2026-08-12T00:00:00.000Z", "day"), "Aug 12");
  assert.equal(bucketLabel("2026-08-12T15:00:00.000Z", "hour"), "Aug 12, 3 PM");
  assert.equal(bucketLabel("2026-08-10T00:00:00.000Z", "week"), "Week of Aug 10");
  assert.equal(bucketLabel("2026-08-01T00:00:00.000Z", "month"), "Aug 2026");
  assert.equal(axisLabel("2026-08-12T15:00:00.000Z", "hour"), "3 PM");
  assert.equal(axisLabel("2026-08-12T00:00:00.000Z", "week"), "Aug 12");
  assert.equal(axisLabel("2026-08-01T00:00:00.000Z", "month"), "Aug");
});

test("about four axis labels anchor the chart, whatever the bucket count", () => {
  assert.deepEqual(axisIndices(24), [0, 6, 12, 18]);
  assert.deepEqual(axisIndices(30), [0, 8, 16, 24]);
  assert.deepEqual(axisIndices(7), [0, 2, 4, 6]);
  assert.deepEqual(axisIndices(3), [0, 1, 2], "few buckets are all labeled");
});

test("the window picker names every offered range", () => {
  assert.equal(windowPhrase("1m"), "30 days");
  const html = renderToStaticMarkup(
    createElement(SpendCompletions, {
      client: { getCompletions: () => new Promise(() => {}) } as never,
      projectId: "p1",
      tick: 0,
    }),
  );
  assert.match(html, /Completed cards/);
  for (const label of ["1D", "1W", "1M", "3M", "6M", "1Y"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /aria-pressed="true"[^>]*aria-label="Last 30 days"/, "the month is the default window");
});
