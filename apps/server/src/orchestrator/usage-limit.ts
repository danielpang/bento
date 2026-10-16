/**
 * An agent CLI that stopped because the account behind it ran out of
 * its plan's usage, and when that usage comes back.
 *
 * Claude Code ends the turn with a result that says so ("You've hit
 * your session limit · resets 7:30pm (UTC)"), and Codex prints its own
 * sentence. Nothing about the work is wrong, and every agent started
 * before the reset fails the same way in two seconds: a swarm restarted
 * its planner nine times in two minutes on one, and then sat until a
 * person noticed hours after the reset.
 */

/** How long to wait when the CLI said it was limited but not until when. */
export const USAGE_LIMIT_FALLBACK_MS = 30 * 60_000;

const LIMIT_PATTERNS = [
  /\bhit your (?:[\w-]+ )*limit\b/i,
  /\busage limit reached\b/i,
  /\b(?:session|weekly|daily|hourly|[0-9]+-hour) limit reached\b/i,
  /\bout of (?:extra )?usage\b/i,
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Whether a run's error is the provider's usage limit. */
export function isUsageLimitError(error: string | null | undefined): boolean {
  if (!error) return false;
  return LIMIT_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * When the limit in this error lifts, read from the CLI's own words,
 * relative to when the run ended. Null when the error is not a usage
 * limit. A reset the text does not give, or gives in a shape this does
 * not read, is USAGE_LIMIT_FALLBACK_MS after the run ended, and a reset
 * is never earlier than that end.
 */
export function usageLimitResetsAt(error: string | null | undefined, endedAt: Date): Date | null {
  if (!error || !isUsageLimitError(error)) return null;
  const parsed = parseReset(error, endedAt);
  if (parsed && parsed.getTime() > endedAt.getTime()) return parsed;
  return new Date(endedAt.getTime() + USAGE_LIMIT_FALLBACK_MS);
}

function parseReset(error: string, endedAt: Date): Date | null {
  // The older Claude Code shape: "Claude AI usage limit reached|1760558400".
  const epoch = /limit reached\|(\d{9,13})/i.exec(error);
  if (epoch) {
    const value = Number(epoch[1]);
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  // Codex: "try again in 2 hours 13 minutes".
  const after = /try again in ((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(error);
  if (after) {
    let ms = 0;
    for (const part of after[1]!.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const n = Number(part[1]);
      const unit = part[2]!.toLowerCase();
      ms += unit.startsWith("d") ? n * 86_400_000 : unit.startsWith("h") ? n * 3_600_000 : unit.startsWith("m") ? n * 60_000 : n * 1000;
    }
    if (ms > 0) return new Date(endedAt.getTime() + ms);
  }

  // Claude Code: "resets 7:30pm (UTC)", "resets Oct 20, 5pm (America/New_York)", "resets 3am".
  const resets = /\bresets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(error);
  if (!resets) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = resets;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const zone = normalizeZone(zoneText?.trim());
  if (!zone) return null;

  const today = partsIn(endedAt, zone);
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const day = Number(dayText);
    if (month < 0 || day < 1 || day > 31) return null;
    let at = zonedToUtc(today.year, month, day, hour, minute, zone);
    // "Jan 2" read on Dec 30 is next year's.
    if (at.getTime() <= endedAt.getTime()) at = zonedToUtc(today.year + 1, month, day, hour, minute, zone);
    return at;
  }
  // A time alone is the next time the clock reads it after the run ended.
  let at = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (at.getTime() <= endedAt.getTime()) at = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
  return at;
}

/** A zone Intl can use, or null. UTC when the CLI named none, which is how it prints in a sandbox. */
function normalizeZone(zone: string | undefined): string | null {
  const name = !zone || /^(utc|gmt|z)$/i.test(zone) ? "UTC" : zone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

function partsIn(at: Date, zone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The instant a wall clock in this zone reads this time. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  // Twice, so a guess that crossed a DST change settles on the right offset.
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(new Date(guess), zone);
    const seenWall = Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    guess += wall - seenWall;
  }
  return new Date(guess);
}
