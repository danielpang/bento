import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnalyticsTotals, FeatureSpend, ProjectAnalytics } from "@bento/api-client";
import { AnalyticsPage, SeriesPicker, StageFlow, SwarmTable, Tiles } from "./components/AnalyticsPage.js";
import {
  ANALYTICS_WINDOWS,
  axisIndices,
  axisLabel,
  bucketLabel,
  chartScale,
  customRangeProblem,
  defaultCustomRange,
  describeDelta,
  describeWindow,
  formatSpend,
  queryFor,
  SERIES,
  windowDays,
} from "./components/analytics-format.js";
import { compareFeatureSpend, formatCardSpend, formatFeatureSpend } from "./components/spend-format.js";

function row(title: string, costUsd: number | null, extra: Partial<FeatureSpend> = {}): FeatureSpend {
  return { featureId: title, title, runs: extra.runs ?? 1, costUsd, runsWithoutCost: extra.runsWithoutCost ?? 0 };
}

test("highest measured spend sorts first, and unmeasured cards sink", () => {
  const cards = [row("quiet", null), row("cheap", 0.1), row("dear", 4.2), row("idle", null, { runs: 0 })];
  const ranked = [...cards].sort((a, b) => compareFeatureSpend(a, b, "spend-desc"));
  assert.deepEqual(
    ranked.map((c) => c.title),
    ["dear", "cheap", "idle", "quiet"],
  );
});

test("ascending spend still leaves unmeasured cards at the bottom", () => {
  const cards = [row("dear", 4.2), row("quiet", null), row("cheap", 0.1)];
  const ranked = [...cards].sort((a, b) => compareFeatureSpend(a, b, "spend-asc"));
  assert.deepEqual(
    ranked.map((c) => c.title),
    ["cheap", "dear", "quiet"],
  );
});

test("title sort is alphabetical and ignores the cost", () => {
  const cards = [row("dear", 4.2), row("cheap", 0.1), row("quiet", null)];
  const ranked = [...cards].sort((a, b) => compareFeatureSpend(a, b, "title-asc"));
  assert.deepEqual(
    ranked.map((c) => c.title),
    ["cheap", "dear", "quiet"],
  );
});

test("a missing cost is not formatted as zero", () => {
  assert.equal(formatFeatureSpend(row("idle", null, { runs: 0 })), "No runs");
  assert.equal(formatFeatureSpend(row("silent", null)), "Not reported");
  assert.equal(formatFeatureSpend(row("partial", 1.2, { runs: 3, runsWithoutCost: 1 })), "$1.20+");
  assert.equal(formatFeatureSpend(row("full", 0.4)), "$0.40");
});

test("a card face prints a figure only when one was reported", () => {
  assert.equal(formatCardSpend(undefined), null);
  assert.equal(formatCardSpend(row("silent", null)), null);
  assert.equal(formatCardSpend(row("partial", 1.2, { runsWithoutCost: 1 })), "$1.20+");
  assert.equal(formatCardSpend(row("full", 0.4)), "$0.40");
});

/**
 * The window picker is the page's one control over everything under
 * it: the month is the default, every preset is offered, and Custom
 * is a choice rather than a preset.
 */
test("the page opens on the last month and offers every window", () => {
  const html = renderToStaticMarkup(
    createElement(AnalyticsPage, {
      client: {
        getAnalytics: () => new Promise(() => {}),
        streamBoard: () => () => {},
      } as never,
      projectId: "p1",
    }),
  );
  assert.match(html, /<h1[^>]*>Analytics<\/h1>/);
  for (const label of ["3D", "1W", "2W", "1M"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /aria-pressed="true"[^>]*aria-label="Last 30 days"/, "the month is the default window");
  assert.match(html, />Custom</);
  assert.match(html, /href="\/"[^>]*>.*Back to board/);
  assert.match(html, /Loading analytics/);
});

test("a preset is a range and a custom window is two dates, once both are valid", () => {
  assert.deepEqual(queryFor({ kind: "preset", range: "2w" }), { range: "2w" });
  assert.deepEqual(queryFor({ kind: "custom", from: "2026-09-01", to: "2026-09-30" }), {
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.equal(queryFor({ kind: "custom", from: "2026-09-01", to: "" }), null, "a half typed window asks for nothing");
  assert.equal(queryFor({ kind: "custom", from: "2026-09-30", to: "2026-09-01" }), null);
  assert.equal(ANALYTICS_WINDOWS.length, 4);
});

test("a custom window says what is wrong with it, and nothing while it is unfinished", () => {
  const today = new Date("2026-10-27T12:00:00Z");
  assert.equal(customRangeProblem("", "2026-10-27", today), null);
  assert.equal(customRangeProblem("2026-10-01", "2026-10-27", today), null);
  assert.equal(customRangeProblem("2026-10-27", "2026-10-27", today), null, "one day is a window");
  assert.match(customRangeProblem("2026-10-27", "2026-10-01", today) ?? "", /before the start/);
  assert.match(customRangeProblem("2026-11-01", "2026-11-02", today) ?? "", /future/);
  assert.match(customRangeProblem("2020-01-01", "2026-10-27", today) ?? "", /three years/);
  assert.match(customRangeProblem("27/10/2026", "2026-10-27", today) ?? "", /YYYY-MM-DD/);
  assert.deepEqual(defaultCustomRange(today), { from: "2026-09-28", to: "2026-10-27" });
});

test("the window note names the days covered and the comparison, in UTC", () => {
  const week = { range: "1w", from: "2026-10-20T14:05:00.000Z", to: "2026-10-27T14:05:00.000Z", bucketUnit: "day" } as const;
  assert.equal(describeWindow(week), "Oct 20 to Oct 27, compared with the 7 days before");
  assert.equal(windowDays(week), 7);
  // A custom window closes at the next midnight, so its last day is
  // the one asked for, not the day after.
  const september = { range: "custom", from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", bucketUnit: "day" } as const;
  assert.equal(describeWindow(september), "Sep 1 to Sep 30, compared with the 30 days before");
  assert.equal(
    describeWindow({ range: "custom", from: "2026-10-27T00:00:00.000Z", to: "2026-10-28T00:00:00.000Z", bucketUnit: "6h" }),
    "Oct 27 to Oct 27, compared with the day before",
    "one day is not \"1 days\"",
  );
});

test("a delta is signed against the previous window of the same length, and only a rise is good news", () => {
  assert.deepEqual(describeDelta(12, 8, 30), { text: "▲ 4 vs previous 30 days", short: "▲ 4 vs previous", tone: "good" });
  assert.deepEqual(describeDelta(8, 12, 7), { text: "▼ 4 vs previous 7 days", short: "▼ 4 vs previous", tone: "bad" });
  assert.deepEqual(describeDelta(3, 3, 14), { text: "Same as previous 14 days", short: "Same as previous", tone: "flat" });
  assert.equal(describeDelta(2, 1, 1).text, "▲ 1 vs previous day");
  assert.equal(formatSpend(4.2, 0), "$4.20");
  assert.equal(formatSpend(4.2, 2), "$4.20+", "a floor wears a plus");
  assert.equal(formatSpend(0.004, 0), "<$0.01");
});

const totals: AnalyticsTotals = {
  cardsCreated: 18,
  cardsCompleted: 12,
  stageMoves: 57,
  stageMovesByHand: 16,
  stageMovesAutomatic: 41,
  runs: 64,
  runsSucceeded: 58,
  runsFailed: 6,
  runsCancelled: 0,
  spendUsd: 42.18,
  runsWithoutCost: 12,
};

const analytics: ProjectAnalytics = {
  window: { range: "1m", from: "2026-09-27T10:00:00.000Z", to: "2026-10-27T10:00:00.000Z", bucketUnit: "day" },
  totals,
  previous: { ...totals, cardsCompleted: 8, cardsCreated: 20 },
  buckets: [{ start: "2026-10-26T00:00:00.000Z", completed: 3, created: 1, stageMoves: 4, runs: 5 }],
  byStage: [
    { stageId: "s1", name: "Implementation", position: 0, movesIn: 16, cardsNow: 4 },
    { stageId: null, name: "Done", position: Number.MAX_SAFE_INTEGER, movesIn: 12, cardsNow: 12 },
  ],
  byFeature: [{ ...row("Rate limit the webhook receiver", 9.84, { runs: 7 }), stageMoves: 5 }],
  bySwarm: [],
};

/**
 * The tiles and the stage rows read from the one answer, so the page
 * cannot disagree with itself about the window.
 */
test("the figures render as tiles against the window before, with the stages under them", () => {
  const tiles = renderToStaticMarkup(createElement(Tiles, { totals, previous: analytics.previous, days: 30 }));
  assert.match(tiles, /Cards completed.*>12<.*\u25B2 4 vs previous 30 days/s);
  assert.match(tiles, /data-tone="good"/, "more completions is colored as good news");
  assert.match(tiles, /Cards created.*>18<.*\u25BC 2 vs previous 30 days/s);
  assert.doesNotMatch(tiles, /data-tone="good"[^>]*>(<span[^>]*>)?\u25BC/, "fewer cards created is not colored as bad news");
  // A phone gets the short forms, one of each pair hidden by CSS.
  assert.match(tiles, /class="analytics-narrow">Completed</);
  assert.match(tiles, /class="analytics-narrow">\u25B2 4 vs previous</);
  assert.match(tiles, /41 automatic, 16 by hand/);
  assert.match(tiles, /58 succeeded, 6 failed/);
  assert.match(tiles, /\$42\.18<\/span>|\$42\.18\+/, "spend is a floor when runs went unreported");
  assert.match(tiles, /12 of 64 runs reported no cost/);

  const stages = renderToStaticMarkup(createElement(StageFlow, { rows: analytics.byStage }));
  assert.match(stages, /Implementation.*width:100%.*>16<.*4 cards now.*>4 now</s);
  assert.match(stages, /Done.*width:75%.*>12<.*12 cards now/s);
});

/**
 * A phone has no room for "Stage moves" in the series picker or for
 * the stage moves column, so it shows "Moves" and drops the column.
 * The button keeps its full name for a screen reader.
 */
test("a phone gets the short series label, and the button keeps its full name", () => {
  assert.equal(SERIES.find((s) => s.key === "stageMoves")?.short, "Moves");
  const html = renderToStaticMarkup(createElement(SeriesPicker, { series: "completed", onChange: () => {} }));
  assert.match(html, /aria-label="Stage moves"[^>]*><span class="analytics-wide">Stage moves<\/span><span class="analytics-narrow">Moves<\/span>/);
  assert.match(html, /aria-pressed="true"[^>]*>Completed</, "a label with no short form is just the label");
});

/** One swarm with money on it, and no cards at all. */
const swarmRow = { swarmId: "sw-1", title: "Rewrite checkout", status: "done", runs: 21, runsWithoutCost: 0, costUsd: 40 };

/**
 * The link off a swarm row has to open that swarm. The console reads
 * which board to show from `board`, and reads nothing at all from
 * `mode`.
 */
test("a swarm row links to the swarm board, by the parameter the console reads", () => {
  const html = renderToStaticMarkup(createElement(SwarmTable, { rows: [swarmRow] }));
  assert.match(html, /href="\/\?board=swarms&amp;swarm=sw-1"/);
  assert.match(html, /\$40\.00/);
  assert.ok(!html.includes("mode=swarms"), "the console never reads a mode parameter");
});

test("a silent swarm has unreported runs instead of an assumed dollar column", () => {
  const html = renderToStaticMarkup(createElement(SwarmTable, { rows: [{ ...swarmRow, runsWithoutCost: 21, costUsd: 0 }] }));
  assert.match(html, /<th[^>]*>Unreported<\/th>/);
  assert.doesNotMatch(html, /<th[^>]*>Assumed<\/th>|<th[^>]*>Estimated<\/th>/);
  assert.equal(renderToStaticMarkup(createElement(SwarmTable, { rows: [] })), "", "no swarms, no heading");
});

test("the y axis ceiling is a clean number at or above the tallest bar", () => {
  assert.equal(chartScale(0), 1, "an empty chart still has a top line");
  assert.equal(chartScale(1), 1);
  assert.equal(chartScale(3), 4, "even below ten, so the midpoint is a whole number");
  assert.equal(chartScale(10), 10);
  assert.equal(chartScale(11), 20);
  assert.equal(chartScale(47), 50);
  assert.equal(chartScale(101), 150);
});

test("bucket labels are formatted in UTC, matching the bucket boundaries", () => {
  assert.equal(bucketLabel("2026-08-12T00:00:00.000Z", "day"), "Aug 12");
  assert.equal(bucketLabel("2026-08-12T18:00:00.000Z", "6h"), "Aug 12, 6 PM");
  assert.equal(bucketLabel("2026-08-10T00:00:00.000Z", "week"), "Week of Aug 10");
  assert.equal(bucketLabel("2026-08-01T00:00:00.000Z", "month"), "Aug 2026");
  assert.equal(axisLabel("2026-08-12T18:00:00.000Z", "6h"), "6 PM");
  assert.equal(axisLabel("2026-08-12T00:00:00.000Z", "6h"), "Aug 12", "midnight names the day");
  assert.equal(axisLabel("2026-08-12T00:00:00.000Z", "week"), "Aug 12");
  assert.equal(axisLabel("2026-08-01T00:00:00.000Z", "month"), "Aug");
});

test("about four axis labels anchor the chart, whatever the bucket count", () => {
  assert.deepEqual(axisIndices(12), [0, 3, 6, 9]);
  assert.deepEqual(axisIndices(30), [0, 8, 16, 24]);
  assert.deepEqual(axisIndices(7), [0, 2, 4, 6]);
  assert.deepEqual(axisIndices(3), [0, 1, 2], "few buckets are all labeled");
});
