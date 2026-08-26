/**
 * Drops replies from an earlier request once a newer one has started.
 *
 * Board spend refetches on every snapshot. Without this, a slower
 * older /usage can overwrite a newer one and a completed card
 * regresses from $4.20 to $1.10.
 */
export function createRequestGate() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(seq: number): boolean {
      return seq === current;
    },
  };
}
