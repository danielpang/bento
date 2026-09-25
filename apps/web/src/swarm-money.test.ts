import assert from "node:assert/strict";
import test from "node:test";
import {
  capUse,
  estimateLine,
  estimateSwarm,
  formatUsd,
  nodeSpendChip,
  nodeSpendLine,
  spendLine,
  spendParts,
  tierLabel,
  tierNote,
  usdFor,
} from "./swarm/money.js";
import { spendOverTime } from "./components/SwarmCostPanel.js";
import type { SwarmSpend, SwarmTask } from "./swarm/types.js";

/**
 * Money, kept in three pieces.
 *
 * The rule these exist for: measured, estimated and assumed are three
 * different kinds of confidence, and adding them produces a number
 * whose accuracy nobody can state. Every assertion below is a way of
 * checking that no line, chip, bar or estimate quietly does it.
 */

const spend: SwarmSpend = { measuredUsd: 1, estimatedUsd: 2, assumedUsd: 3 , notionalUsd: 0};

test("every figure is carried apart, and the total is never one of them", () => {
  const parts = spendParts(spend);
  assert.deepEqual(
    parts.map((part) => [part.tier, part.usd]),
    [
      ["measured", 1],
      ["estimated", 2],
      ["assumed", 3],
      ["notional", 0],
    ],
  );
  const line = spendLine(spend);
  assert.equal(line, "$1.00 measured, $2.00 estimated, $3.00 assumed, $0.00 notional");
  // The one number nobody may print: 1 + 2 + 3.
  assert.ok(!line.includes("$6.00"));
});

test("the tiers are always all of them, in one order, even at zero", () => {
  const parts = spendParts({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0 });
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((part) => part.tier), ["measured", "estimated", "assumed", "notional"]);
  assert.equal(
    spendLine({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0 }),
    "$0.00 measured, $0.00 estimated, $0.00 assumed, $0.00 notional",
  );
});

test("each tier says why it is in that tier", () => {
  assert.equal(tierLabel("measured"), "measured");
  assert.match(tierNote("measured"), /Reported by the tool/);
  assert.match(tierNote("estimated"), /tokens/);
  assert.match(tierNote("assumed"), /reports no cost/);
  assert.equal(usdFor(spend, "assumed"), 3);
});

test("a node prints only the tiers it has actually spent in", () => {
  assert.equal(nodeSpendLine({ measuredUsd: 1.4, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0}), "$1.40 measured");
  assert.equal(
    nodeSpendLine({ measuredUsd: 1.4, estimatedUsd: 0.25, assumedUsd: 0 , notionalUsd: 0}),
    "$1.40 measured, $0.25 estimated",
  );
  assert.equal(nodeSpendLine({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0}), "$0.00");
});

test("a node's chip marks more tiers with a plus, never with a sum", () => {
  const one = nodeSpendChip({ measuredUsd: 1.4, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0});
  assert.equal(one.text, "$1.40");
  const two = nodeSpendChip({ measuredUsd: 1.4, estimatedUsd: 0.25, assumedUsd: 0 , notionalUsd: 0});
  assert.equal(two.text, "$1.40+");
  assert.ok(!two.text.includes("1.65"));
  // The other tiers are named rather than added.
  assert.match(two.title, /\$0\.25 estimated/);
  assert.equal(nodeSpendChip({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0}).text, "$0.00");
});

test("the budget bar is one segment per tier against the cap, with no combined fill", () => {
  const use = capUse({ measuredUsd: 10, estimatedUsd: 5, assumedUsd: 5, notionalUsd: 0 }, 40);
  assert.deepEqual(
    use.segments.map((segment) => [segment.tier, segment.ratio]),
    [
      ["measured", 0.25],
      ["estimated", 0.125],
      ["assumed", 0.125],
      ["notional", 0],
    ],
  );
  assert.equal(use.capLine, "against a $40.00 cap");
  assert.equal(use.spent, false);
  // Nothing on the answer is the 0.5 those three come to.
  assert.ok(!Object.values(use).includes(0.5));
});

/**
 * Every billed tier closes a budget, and the fourth one never does.
 *
 * It used to be measured alone, which was the wrong half of the
 * argument: a swarm whose tools print nothing would have run forever
 * against any cap, because nothing it ever spent would have been
 * measured. The server enforces all three billed tiers, so the console
 * draws the same line, and says when a cap is soft rather than
 * pretending an assumed figure does not count.
 */
test("everything the budget counts can close it, and the notional tier never can", () => {
  assert.equal(capUse({ measuredUsd: 20, estimatedUsd: 10, assumedUsd: 5, notionalUsd: 0 }, 40).spent, false);
  assert.equal(capUse({ measuredUsd: 20, estimatedUsd: 10, assumedUsd: 10, notionalUsd: 0 }, 40).spent, true);
  assert.equal(capUse({ measuredUsd: 40, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0 }, 40).spent, true);

  // A subscription's list price does not stop anything, whatever it says.
  const borrowed = capUse({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 400 }, 40);
  assert.equal(borrowed.spent, false);
  assert.equal(borrowed.notional, true, "and the panel says why the cap is not stopping it");
});

/**
 * A cap enforced against mostly assumed figures is a cap enforced
 * against a guess. The product says so while the swarm is running.
 */
test("a cap held up mostly by assumed figures is called soft", () => {
  assert.equal(capUse({ measuredUsd: 9, estimatedUsd: 0, assumedUsd: 1, notionalUsd: 0 }, 40).soft, false);
  assert.equal(capUse({ measuredUsd: 5, estimatedUsd: 0, assumedUsd: 5, notionalUsd: 0 }, 40).soft, true);
});

test("a swarm with no cap says so rather than drawing a full bar", () => {
  const use = capUse(spend, null);
  assert.equal(use.capLine, "no cap set");
  assert.deepEqual(use.segments.map((segment) => segment.ratio), [0, 0, 0, 0]);
  assert.equal(use.spent, false);
});

test("a segment cannot overflow its own track", () => {
  const use = capUse({ measuredUsd: 400, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0}, 40);
  assert.equal(use.segments[0]!.ratio, 1);
  assert.equal(use.spent, true);
});

test("dollars print the way every other figure in the console does", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(1.2), "$1.20");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(Number.NaN), "$0.00");
});

test("an estimate is the template's per task figures, kept in their tiers", () => {
  const template = {
    perLeaf: { measuredUsd: 0.5, estimatedUsd: 0.1, assumedUsd: 0.2 , notionalUsd: 0},
    typicalLeaves: 10,
  };
  assert.deepEqual(estimateSwarm(template), { measuredUsd: 5, estimatedUsd: 1, assumedUsd: 2 , notionalUsd: 0});
  assert.deepEqual(estimateSwarm(template, 2), { measuredUsd: 1, estimatedUsd: 0.2, assumedUsd: 0.4 , notionalUsd: 0});
  const line = estimateLine(estimateSwarm(template, 2), 2);
  assert.equal(line, "About $1.00 measured, $0.20 estimated, $0.40 assumed over 2 tasks.");
  assert.ok(!line.includes("$1.60"));
  assert.match(estimateLine(estimateSwarm(template, 1), 1), /over 1 task\./);
});

/**
 * The sparkline is the one place a running figure is unavoidable, and
 * it was the one place the tiers were added together.
 *
 * A cumulative line has to accumulate something, so what it
 * accumulates has to be a figure that means something on its own. The
 * only such figure in this design is what the cap counts: the three
 * tiers somebody is actually billed for. Adding the fourth put a list
 * price a subscription had already paid for into the same running
 * total as a measurement, and then read it out to a screen reader as
 * the figure the swarm ended at.
 */
test("the shape of spend over time is the spend the budget counts, and not the fourth tier", () => {
  const leaf = (endedAt: string | null, cost: Partial<SwarmSpend>): SwarmTask =>
    ({
      id: endedAt ?? "open",
      nodeType: "leaf",
      endedAt,
      cost: { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0, ...cost },
    }) as SwarmTask;

  const points = spendOverTime([
    leaf("2026-01-01T00:00:00Z", { measuredUsd: 1 }),
    leaf("2026-01-01T00:01:00Z", { estimatedUsd: 2 }),
    leaf("2026-01-01T00:02:00Z", { assumedUsd: 3 }),
    // A borrowed subscription's list price, which the budget does not
    // count and which must not move this line either.
    leaf("2026-01-01T00:03:00Z", { notionalUsd: 400 }),
    // Still working, so not on the line at all.
    leaf(null, { measuredUsd: 99 }),
  ]);
  assert.deepEqual(points, [1, 3, 6, 6]);
  assert.ok(!points.includes(406), "the one number nobody may print, in its cumulative form");
});
