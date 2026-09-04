/**
 * Wall-clock hours a run spent inside a billing period.
 *
 * Billing meters finished (and still-running) sandbox time, not token
 * spend. A run that started last period and ended in this one only
 * counts the overlap, so the card breakdown can sit next to the period
 * meter without inventing hours from outside it.
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
};

/**
 * Hours by card for a period. Cards that spent nothing are omitted:
 * this is a ranking of spenders, not a board.
 */
export function hoursByFeature(
  runs: RunSlice[],
  periodStart: Date,
  periodEnd: Date,
  now = new Date(),
): { featureId: string; title: string; agentHours: number }[] {
  const totals = new Map<string, { title: string; hours: number }>();
  for (const run of runs) {
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
