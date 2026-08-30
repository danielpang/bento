import type { CompletionRange, ProjectCompletions } from "@bento/api-client";

/**
 * The windows the completions chart offers, in the order the picker
 * shows them. `window` is the phrase the headline uses: "in the last
 * 30 days", not "1m".
 */
export const COMPLETION_WINDOWS: { range: CompletionRange; label: string; window: string }[] = [
  { range: "1d", label: "1D", window: "24 hours" },
  { range: "1w", label: "1W", window: "7 days" },
  { range: "1m", label: "1M", window: "30 days" },
  { range: "3m", label: "3M", window: "3 months" },
  { range: "6m", label: "6M", window: "6 months" },
  { range: "1y", label: "1Y", window: "12 months" },
];

export function windowPhrase(range: CompletionRange): string {
  return COMPLETION_WINDOWS.find((w) => w.range === range)?.window ?? range;
}

/**
 * The y-axis ceiling: the smallest clean number at or above the tallest
 * bar. Even below ten so the midpoint gridline is a whole number, then
 * tens, then fifties.
 */
export function completionScale(max: number): number {
  if (max <= 1) return 1;
  if (max <= 10) return 2 * Math.ceil(max / 2);
  if (max <= 100) return 10 * Math.ceil(max / 10);
  return 50 * Math.ceil(max / 50);
}

type BucketUnit = ProjectCompletions["bucketUnit"];

/**
 * Buckets open on UTC boundaries, so their labels are formatted in UTC:
 * a bar that covers Aug 12 must not be labeled Aug 11 for a viewer west
 * of Greenwich.
 */
export function bucketLabel(startIso: string, unit: BucketUnit): string {
  const start = new Date(startIso);
  switch (unit) {
    case "hour":
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
export function axisLabel(startIso: string, unit: BucketUnit): string {
  const start = new Date(startIso);
  switch (unit) {
    case "hour":
      return utcFormat(start, { hour: "numeric" });
    case "day":
    case "week":
      return utcFormat(start, { month: "short", day: "numeric" });
    case "month":
      return utcFormat(start, { month: "short" });
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
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date).replace(/\u202f/g, " ");
}
