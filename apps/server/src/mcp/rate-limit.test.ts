import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBuckets } from "./rate-limit.js";

/**
 * The regression these exist for: both MCP surfaces shipped a limiter
 * that dropped its own state after every take, so no burst was ever
 * refused. Each test below fails against that version.
 */

/** The endpoint's real budget: 30 requests, refilling at 3 a second. */
function limiter(now: () => number) {
  return new TokenBuckets({ capacity: 30, refillPerMs: 3 / 1000, now });
}

test("a burst inside one instant is refused past the capacity", () => {
  const buckets = limiter(() => 1_000_000);
  let allowed = 0;
  for (let i = 0; i < 1000; i += 1) if (buckets.take("conn")) allowed += 1;
  assert.equal(allowed, 30, "exactly the capacity may pass with no time to refill");
});

test("an exhausted bucket keeps refusing until it has refilled", () => {
  let clock = 1_000_000;
  const buckets = limiter(() => clock);
  for (let i = 0; i < 30; i += 1) assert.equal(buckets.take("conn"), true);
  assert.equal(buckets.take("conn"), false, "the 31st in the same instant is refused");

  // A third of a second buys one token back, and only one.
  clock += 334;
  assert.equal(buckets.take("conn"), true);
  assert.equal(buckets.take("conn"), false);
});

test("state survives between takes rather than resetting to full", () => {
  let clock = 1_000_000;
  const buckets = limiter(() => clock);
  for (let i = 0; i < 20; i += 1) buckets.take("conn");
  // One second refills three, so the bucket is at 13, not back at 30.
  clock += 1_000;
  let allowed = 0;
  for (let i = 0; i < 100; i += 1) if (buckets.take("conn")) allowed += 1;
  assert.equal(allowed, 13, "the earlier spend is still counted against this caller");
});

test("one caller's burst does not spend another's budget", () => {
  const buckets = limiter(() => 1_000_000);
  for (let i = 0; i < 30; i += 1) buckets.take("noisy");
  assert.equal(buckets.take("noisy"), false);
  assert.equal(buckets.take("quiet"), true, "a separate connection has its own bucket");
});

test("buckets are dropped once they refill, and kept while under pressure", () => {
  let clock = 1_000_000;
  const buckets = limiter(() => clock);
  for (let i = 0; i < 30; i += 1) buckets.take("conn");
  assert.equal(buckets.size, 1, "an exhausted bucket is retained");

  // Not yet full: a sweep must leave it alone or the limit resets.
  clock += 1_000;
  buckets.sweep(clock);
  assert.equal(buckets.size, 1, "a partly refilled bucket is still tracked");
  assert.equal(buckets.take("conn"), true);

  // Fully refilled: now it carries no information worth the memory.
  clock += 60_000;
  buckets.sweep(clock);
  assert.equal(buckets.size, 0, "a refilled bucket is forgotten");
});

test("the sweep runs on its own from take, with no timer to leak", () => {
  let clock = 1_000_000;
  const buckets = new TokenBuckets({ capacity: 30, refillPerMs: 3 / 1000, sweepIntervalMs: 1_000, now: () => clock });
  buckets.take("old");
  assert.equal(buckets.size, 1);

  // "old" has refilled by now, and taking for anyone triggers the sweep.
  clock += 60_000;
  buckets.take("new");
  assert.equal(buckets.size, 1, "only the caller that just took is tracked");
});
