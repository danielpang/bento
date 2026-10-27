import type { AnalyticsBucketUnit, AnalyticsQuery, AnalyticsRange, AnalyticsTotals, ProjectAnalytics } from "@bento/api-client";

/**
 * The preset windows the Analytics page offers, in the order the
 * picker shows them. `window` is the phrase a sentence uses: "the last
 * 30 days", not "1m". The month is the default; anything longer is a
 * custom window, two dates of the person's choosing.
 */
export const ANALYTICS_WINDOWS: { range: AnalyticsRange; label: string; window: string }[] = [
  { range: "3d", label: "3D", window: "3 days" },
  { range: "1w", label: "1W", window: "7 days" },
  { range: "2w", label: "2W", window: "14 days" },
  { range: "1m", label: "1M", window: "30 days" },
];

export const DEFAULT_RANGE: AnalyticsRange = "1m";

/**
 * What the page is looking at, as the picker holds it. A custom window
 * is kept as the two date strings the inputs hold, so a half typed
 * date is state without being a request.
 */
export type WindowChoice = { kind: "preset"; range: AnalyticsRange } | { kind: "custom"; from: string; to: string };

/** The request a choice makes, or null while a custom window is not yet a valid one. */
export function queryFor(choice: WindowChoice): AnalyticsQuery | null {
  if (choice.kind === "preset") return { range: choice.range };
  if (!choice.from || !choice.to || customRangeProblem(choice.from, choice.to) !== null) return null;
  return { from: choice.from, to: choice.to };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The server's ceiling, so the page refuses what the route would refuse. */
export const MAX_CUSTOM_DAYS = 1096;

/**
 * Why a custom window cannot be asked for yet, in the words the page
 * shows beside the inputs, or null when it can. Empty fields are not a
 * problem to announce: the person has not finished.
 */
/**
 * A date as midnight UTC, or null when it is not a real day. The same
 * round trip the server does: Date.parse reads Feb 30 as Mar 2, and a
 * window the page accepted that the route then refuses would show as
 * a failure toast instead of the line beside the fields.
 */
function utcDay(value: string): number | null {
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

export function customRangeProblem(from: string, to: string, today: Date = new Date()): string | null {
  if (!from || !to) return null;
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to)) return "Enter both dates as YYYY-MM-DD.";
  const start = utcDay(from);
  const end = utcDay(to);
  if (start === null || end === null) return "Enter both dates as YYYY-MM-DD.";
  if (end < start) return "The end date comes before the start.";
  if (start > today.getTime()) return "The window starts in the future.";
  if (end + DAY_MS - start > MAX_CUSTOM_DAYS * DAY_MS) return "A window can cover at most three years.";
  return null;
}

/** The custom window to offer when the picker opens: the last 30 UTC days, today included. */
export function defaultCustomRange(today: Date = new Date()): { from: string; to: string } {
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

/** How many days a window covers, which is also how long the window before it is. */
export function windowDays(window: ProjectAnalytics["window"]): number {
  return Math.max(1, Math.round((new Date(window.to).getTime() - new Date(window.from).getTime()) / DAY_MS));
}

/** "30 days", or "day" for one, as in "the previous day". */
function daysPhrase(days: number): string {
  return days === 1 ? "day" : `${days} days`;
}

/**
 * The line beside the picker: which days the figures cover and what
 * the deltas compare against. The picker already says which preset is
 * on, so this names only the dates. Both ends are formatted in UTC,
 * because the window's boundaries are.
 */
export function describeWindow(window: ProjectAnalytics["window"]): string {
  const from = new Date(window.from);
  // The window is half open, so the last day it covers is the day
  // before `to`: a custom window to Oct 27 closes at Oct 28 00:00.
  const last = new Date(new Date(window.to).getTime() - 1);
  const span = utcFormat(from, { month: "short", day: "numeric" }) + " to " + utcFormat(last, { month: "short", day: "numeric" });
  return `${span}, compared with the ${daysPhrase(windowDays(window))} before`;
}

/**
 * The line under a tile's figure: the change against the previous
 * window of the same length. `short` drops the length, for a phone,
 * where the line beside the picker already says it. `tone` says which
 * way it went; the page colors only a rise in completions, because a
 * drop in cards created is not a failure and a rise in failed runs is
 * not progress.
 */
export function describeDelta(
  current: number,
  previous: number,
  days: number,
): { text: string; short: string; tone: "good" | "bad" | "flat" } {
  const diff = current - previous;
  const lead = diff === 0 ? "Same as previous" : `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} vs previous`;
  return { text: `${lead} ${daysPhrase(days)}`, short: lead, tone: diff === 0 ? "flat" : diff > 0 ? "good" : "bad" };
}

/** The chart's series, one at a time: what the picker above it offers. */
export type Series = "completed" | "created" | "stageMoves" | "runs";

/** `short` is what a phone shows when the label does not fit; the button's name stays `label`. */
export const SERIES: { key: Series; label: string; short?: string; noun: (n: number) => string }[] = [
  { key: "completed", label: "Completed", noun: (n) => `card${n === 1 ? "" : "s"} completed` },
  { key: "created", label: "Created", noun: (n) => `card${n === 1 ? "" : "s"} created` },
  { key: "stageMoves", label: "Stage moves", short: "Moves", noun: (n) => `stage move${n === 1 ? "" : "s"}` },
  { key: "runs", label: "Runs", noun: (n) => `run${n === 1 ? "" : "s"} finished` },
];

/** The tile a series answers to, so the chart's headline agrees with the tile above it. */
export function seriesTotal(totals: AnalyticsTotals, series: Series): number {
  switch (series) {
    case "completed":
      return totals.cardsCompleted;
    case "created":
      return totals.cardsCreated;
    case "stageMoves":
      return totals.stageMoves;
    case "runs":
      return totals.runs;
  }
}

/**
 * The y-axis ceiling: the smallest clean number at or above the tallest
 * bar. Even below ten so the midpoint gridline is a whole number, then
 * tens, then fifties.
 */
export function chartScale(max: number): number {
  if (max <= 1) return 1;
  if (max <= 10) return 2 * Math.ceil(max / 2);
  if (max <= 100) return 10 * Math.ceil(max / 10);
  return 50 * Math.ceil(max / 50);
}

/**
 * Buckets open on UTC boundaries, so their labels are formatted in UTC:
 * a bar that covers Aug 12 must not be labeled Aug 11 for a viewer west
 * of Greenwich.
 */
export function bucketLabel(startIso: string, unit: AnalyticsBucketUnit): string {
  const start = new Date(startIso);
  switch (unit) {
    case "6h":
      return utcFormat(start, { month: "short", day: "numeric", hour: "numeric" });
    case "day":
      return utcFormat(start, { month: "short", day: "numeric" });
    case "week":
      return `Week of ${utcFormat(start, { month: "short", day: "numeric" })}`;
    case "month":
      return utcFormat(start, { month: "short", year: "numeric" });
  }
}

/** The short form that fits under a bar on the x-axis. */
export function axisLabel(startIso: string, unit: AnalyticsBucketUnit): string {
  const start = new Date(startIso);
  switch (unit) {
    case "6h":
      return start.getUTCHours() === 0
        ? utcFormat(start, { month: "short", day: "numeric" })
        : utcFormat(start, { hour: "numeric" });
    case "day":
    case "week":
      return utcFormat(start, { month: "short", day: "numeric" });
    case "month":
      return utcFormat(start, { month: "short" });
  }
}

/** What one bar is, for the chart's headline: "one bar per day". */
export function bucketPhrase(unit: AnalyticsBucketUnit): string {
  switch (unit) {
    case "6h":
      return "one bar per six hours";
    case "day":
      return "one bar per day";
    case "week":
      return "one bar per week";
    case "month":
      return "one bar per month";
  }
}

/**
 * Which buckets get an x-axis label. Every slot labeled is unreadable
 * at thirty bars, so about four evenly spaced labels anchor the axis
 * and the tooltip names the rest.
 */
export function axisIndices(count: number, want = 4): number[] {
  if (count <= want) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / want);
  const picks: number[] = [];
  for (let i = 0; i < count; i += step) picks.push(i);
  return picks;
}

function utcFormat(date: Date, options: Intl.DateTimeFormatOptions): string {
  // Newer ICU puts a narrow no-break space before AM and PM, which
  // renders as a tofu box in some monospace stacks. A plain space is
  // wanted everywhere this string appears.
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date).replace(/ /g, " ");
}
