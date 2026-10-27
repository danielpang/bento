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

/**
 * A span long enough to be counted in days, as a figure on the page.
 *
 * Under a day it is `formatElapsed`. A swarm that ran a weekend reads
 * as "2d 6h" rather than "54h 12m", the same two parts at most.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return formatElapsed(ms);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * How long ago something happened, in the few characters a table cell
 * has: "just now", "12m ago", "3h ago", "2d ago", and the date once it
 * is more than a week old. A stamp in the future (a clock ahead of the
 * server's) reads as just now rather than as a negative age.
 */
export function formatAge(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return shortDate(iso, now);
}

/** A date as the page prints one: "Oct 24", with the year only when it is not this one. */
export function shortDate(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
