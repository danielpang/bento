/** An agent CLI that stopped because its account ran out of usage, and when that usage comes back. */

export const USAGE_LIMIT_FALLBACK_MS = 30 * 60_000;
/** A run's error can carry the agent's stderr, so a printed reset a minute away must not buy a restart a minute. */
export const USAGE_LIMIT_MIN_WAIT_MS = 15 * 60_000;
/** Limits waited out in a row before the run is handled as an ordinary failure. */
export const MAX_USAGE_LIMIT_WAITS = 5;

/**
 * Anchored at the start of the error, which is the CLI's own result text;
 * an agent's stderr only ever follows another opening.
 */
export const USAGE_LIMIT_OPENING =
  /^\s*(?:You(?:'|\u2019)ve hit your (?:[\w-]+ )*limit\b|(?:Claude AI )?[Uu]sage limit reached\b|(?:[Ss]ession|[Ww]eekly|[Dd]aily|\d+-hour) limit reached\b)/;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function isUsageLimitError(error: string | null | undefined): boolean {
  return Boolean(error && USAGE_LIMIT_OPENING.test(error));
}

/** Null when the error is not a usage limit. Never sooner than USAGE_LIMIT_MIN_WAIT_MS after the run ended. */
export function usageLimitResetsAt(error: string | null | undefined, endedAt: Date): Date | null {
  if (!isUsageLimitError(error)) return null;
  const parsed = parseReset(error!, endedAt);
  const resetsAt = parsed && parsed.getTime() > endedAt.getTime() ? parsed.getTime() : endedAt.getTime() + USAGE_LIMIT_FALLBACK_MS;
  return new Date(Math.max(resetsAt, endedAt.getTime() + USAGE_LIMIT_MIN_WAIT_MS));
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
  let at = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (at.getTime() <= endedAt.getTime()) at = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
  return at;
}

/** UTC when the CLI named none, which is how it prints in a sandbox. */
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

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, zone: string): Date {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  // Twice, so a guess across a DST change settles.
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(new Date(guess), zone);
    const seenWall = Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    guess += wall - seenWall;
  }
  return new Date(guess);
}
