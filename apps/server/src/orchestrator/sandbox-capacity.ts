import { sandboxErrorKind } from "@bento/sandbox";

export interface CapacityAttempt {
  provider: string;
  phase?: string;
  blame?: string;
  reason: unknown;
}

/** A concurrency ceiling is different from a request rate limit or an outage. */
export function isCapacityAttempt(attempt: CapacityAttempt): boolean {
  if (attempt.blame === "project") return false;
  if (attempt.phase && !["acquire", "create"].includes(attempt.phase)) return false;
  if (attempt.provider !== "sprite" && attempt.provider !== "modal") return false;
  const seen = new Set<unknown>();
  for (let error = attempt.reason; error && !seen.has(error);) {
    seen.add(error);
    if (attempt.provider === "sprite" && sandboxErrorKind(error) === "capacity") return true;
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (attempt.provider === "sprite" && /concurrent_sprite_limit_exceeded|max sprites per org exceeded/i.test(message)) return true;
    // Modal's SDK exposes service errors as messages. RESOURCE_EXHAUSTED
    // alone also covers API throttling, so require the actual resource ceiling.
    if (attempt.provider === "modal" &&
      !/rate.?limit|requests? per|billing|payment|budget/i.test(message) &&
      /(?:sandbox|container|concurr)/i.test(message) &&
      /(?:limit|quota|maximum|max number)/i.test(message) &&
      /(?:exceed|reach|too many)/i.test(message)
    ) return true;
    error = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined;
  }
  return false;
}

export function allAttemptsAtCapacity(attempts: readonly CapacityAttempt[]): boolean {
  return attempts.length > 0 && attempts.every(isCapacityAttempt);
}
