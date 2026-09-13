/**
 * Elapsed time, as a swarm needs it read.
 *
 * A card's run duration is minutes and seconds, because a stage takes
 * minutes. A swarm runs for hours, and "184m 12s" is a number nobody
 * converts in their head, so the unit steps up: seconds under a
 * minute, minutes and seconds under an hour, hours and minutes above
 * it. Two parts at most, which is what keeps it the width of a chip.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** The same figure from a stamp, for a header that ticks on its own. */
export function elapsedSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, now - started);
}
