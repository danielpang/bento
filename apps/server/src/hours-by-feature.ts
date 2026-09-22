const PROVISION_FAILURE = "sandbox provisioning failed:";

/**
 * A failed run that died because Bento or Fly failed, not because the
 * agent did the work and failed at it.
 *
 * These do not count as agent hours. The usual case is Fly answering
 * `service temporarily unavailable` from acquireSprite, which is stored
 * as `sandbox provisioning failed: APIError: ...` and means the sprite
 * never became a running agent. An unexpected throw from the exec loop
 * (`exec failed:`) and a toolchain that never installed the CLI are the
 * same kind of failure: our machine, not the card's work.
 *
 * Two provision failures are the caller's own configuration, thrown
 * before a sprite exists. Those stay on the clock. So does an agent
 * that ran and reported its own failure, a timeout, and a restart: the
 * sandbox was awake for that time, and a restart is not a refund.
 */
export function isInfrastructureFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  const cause = error.startsWith(PROVISION_FAILURE) ? error.slice(PROVISION_FAILURE.length).trim() : error;
  if (/^Repositories .+ use the same checkout/.test(cause)) return false;
  if (cause.startsWith("This organization requires agents to run without network access")) return false;
  if (error.startsWith(PROVISION_FAILURE)) return true;
  if (error.startsWith("exec failed:")) return true;
  return /is not installed in this sandbox, so the agent never started/.test(error);
}

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
 * ranking of spenders, not a board. A run that failed because Bento
 * or Fly could not run the sprite is omitted even when it still has
 * a start time, so rows written before that start was cleared do not
 * keep spending the quota.
 */
export function hoursByFeature(
  runs: RunSlice[],
  periodStart: Date,
  periodEnd: Date,
  now = new Date(),
): { featureId: string; title: string; agentHours: number }[] {
  const totals = new Map<string, { title: string; hours: number }>();
  for (const run of runs) {
    if (isInfrastructureFailure(run.error)) continue;
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
