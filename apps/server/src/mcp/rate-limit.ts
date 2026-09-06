/**
 * Token buckets keyed by grant or connection, for the two MCP surfaces
 * that answer callers holding a token rather than a session.
 *
 * This lives in one place because both surfaces had their own copy of
 * it and both copies were dead. The bug is worth naming so it is not
 * reintroduced: each copy dropped its map entry after a successful
 * take, guarded by `tokens >= capacity - 1`. A bucket has exactly
 * `capacity - 1` tokens immediately after its first take, so the guard
 * matched every time, the entry was deleted, and the next request
 * built a fresh full bucket. A thousand requests in the same
 * millisecond were all allowed against a cap of thirty.
 *
 * So state is kept for as long as a bucket is under pressure, and
 * dropped only once it has refilled to full, at which point it is
 * genuinely indistinguishable from a bucket that never existed. The
 * sweep runs from `take`, so there is no timer to leak and nothing to
 * shut down.
 */

export interface TokenBucketOptions {
  /** Burst size, and the level a bucket refills to. */
  capacity: number;
  /** Tokens added per millisecond of idleness. */
  refillPerMs: number;
  /** How often the map is swept for buckets that have refilled. */
  sweepIntervalMs?: number;
  /** Injectable clock, so the tests do not sleep. */
  now?: () => number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.lastSweep = this.now();
  }

  /** True when this request is within budget, false when it is not. */
  take(key: string): boolean {
    const now = this.now();
    if (now - this.lastSweep >= this.sweepIntervalMs) this.sweep(now);

    const existing = this.buckets.get(key);
    const tokens = existing
      ? Math.min(this.capacity, existing.tokens + (now - existing.at) * this.refillPerMs)
      : this.capacity;

    if (tokens < 1) {
      // Kept, not dropped: a bucket that is out of tokens is precisely
      // the one whose state must survive to the next request.
      this.buckets.set(key, { tokens, at: now });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  /** Drops every bucket that has refilled to capacity. */
  sweep(at = this.now()): void {
    this.lastSweep = at;
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (at - bucket.at) * this.refillPerMs >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }

  /** How many buckets are being tracked. For the tests and nothing else. */
  get size(): number {
    return this.buckets.size;
  }
}
