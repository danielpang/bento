import { unbilledReason } from "./unbilled-reasons.js";

/**
 * Wall-clock hours a run spent inside a billing month.
 *
 * The window is the plan's period: from the organization's billing
 * start to the next anniversary, not 1 to 30 of the calendar month.
 * Billing meters finished (and still-running) sandbox time, not token
 * spend. A run that started last period and ended in this one only
 * counts the overlap, so the card breakdown can sit next to the period
 * meter without inventing hours from outside it. A run with no start
 * counts as zero, which is also how an infrastructure failure is
 * recorded once it has been closed.
 */
export function runHoursInPeriod(
  startedAt: Date | null,
  endedAt: Date | null,
  periodStart: Date,
  periodEnd: Date,
  now = new Date(),
): number {
  if (!startedAt) return 0;
  const end = endedAt ?? now;
  const overlapStart = Math.max(startedAt.getTime(), periodStart.getTime());
  const overlapEnd = Math.min(end.getTime(), periodEnd.getTime());
  if (overlapEnd <= overlapStart) return 0;
  return (overlapEnd - overlapStart) / 3_600_000;
}

export type RunSlice = {
  featureId: string;
  title: string;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The run's failure text, when the hours sum should be able to drop it. */
  error?: string | null;
};

/**
 * Hours by card for a billing month. Every run on a feature is summed.
 * Cards that spent nothing in the window are omitted: this is a
 * ranking of spenders, not a board. A run whose error matches
 * UNBILLED_REASONS is omitted even when it still has a start time,
 * so rows written before that start was cleared do not keep spending
 * the quota.
 */
export function hoursByFeature(
  runs: RunSlice[],
  periodStart: Date,
  periodEnd: Date,
  now = new Date(),
): { featureId: string; title: string; agentHours: number }[] {
  const totals = new Map<string, { title: string; hours: number }>();
  for (const run of runs) {
    if (unbilledReason(run.error)) continue;
    const hours = runHoursInPeriod(run.startedAt, run.endedAt, periodStart, periodEnd, now);
    if (hours <= 0) continue;
    const current = totals.get(run.featureId);
    if (current) current.hours += hours;
    else totals.set(run.featureId, { title: run.title, hours });
  }
  return [...totals.entries()].map(([featureId, row]) => ({
    featureId,
    title: row.title,
    agentHours: row.hours,
  }));
}
