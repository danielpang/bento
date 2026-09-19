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
import type { SwarmSpend } from "./swarm/types.js";

/**
 * Money, kept in three pieces.
 *
 * The rule these exist for: measured, estimated and assumed are three
 * different kinds of confidence, and adding them produces a number
 * whose accuracy nobody can state. Every assertion below is a way of
 * checking that no line, chip, bar or estimate quietly does it.
 */

const spend: SwarmSpend = { measuredUsd: 1, estimatedUsd: 2, assumedUsd: 3 };

test("every figure is carried apart, and the total is never one of them", () => {
  const parts = spendParts(spend);
  assert.deepEqual(
    parts.map((part) => [part.tier, part.usd]),
    [
      ["measured", 1],
      ["estimated", 2],
      ["assumed", 3],
    ],
  );
  const line = spendLine(spend);
  assert.equal(line, "$1.00 measured, $2.00 estimated, $3.00 assumed");
  // The one number nobody may print: 1 + 2 + 3.
  assert.ok(!line.includes("$6.00"));
  assert.ok(!line.includes("6"));
});

test("the tiers are always all three, in one order, even at zero", () => {
  const parts = spendParts({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 });
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((part) => part.tier), ["measured", "estimated", "assumed"]);
  assert.equal(spendLine({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 }),
    "$0.00 measured, $0.00 estimated, $0.00 assumed");
});

test("each tier says why it is in that tier", () => {
  assert.equal(tierLabel("measured"), "measured");
  assert.match(tierNote("measured"), /Reported by the tool/);
  assert.match(tierNote("estimated"), /tokens/);
  assert.match(tierNote("assumed"), /reports no cost/);
  assert.equal(usdFor(spend, "assumed"), 3);
});

test("a node prints only the tiers it has actually spent in", () => {
  assert.equal(nodeSpendLine({ measuredUsd: 1.4, estimatedUsd: 0, assumedUsd: 0 }), "$1.40 measured");
  assert.equal(
    nodeSpendLine({ measuredUsd: 1.4, estimatedUsd: 0.25, assumedUsd: 0 }),
    "$1.40 measured, $0.25 estimated",
  );
  assert.equal(nodeSpendLine({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 }), "$0.00");
});

test("a node's chip marks more tiers with a plus, never with a sum", () => {
  const one = nodeSpendChip({ measuredUsd: 1.4, estimatedUsd: 0, assumedUsd: 0 });
  assert.equal(one.text, "$1.40");
  const two = nodeSpendChip({ measuredUsd: 1.4, estimatedUsd: 0.25, assumedUsd: 0 });
  assert.equal(two.text, "$1.40+");
  assert.ok(!two.text.includes("1.65"));
  // The other tiers are named rather than added.
  assert.match(two.title, /\$0\.25 estimated/);
  assert.equal(nodeSpendChip({ measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 }).text, "$0.00");
});

test("the budget bar is three segments against the cap, with no combined fill", () => {
  const use = capUse({ measuredUsd: 10, estimatedUsd: 5, assumedUsd: 5 }, 40);
  assert.deepEqual(
    use.segments.map((segment) => [segment.tier, segment.ratio]),
    [
      ["measured", 0.25],
      ["estimated", 0.125],
      ["assumed", 0.125],
    ],
  );
  assert.equal(use.capLine, "against a $40.00 cap");
  assert.equal(use.spent, false);
  // Nothing on the answer is the 0.5 those three come to.
  assert.ok(!Object.values(use).includes(0.5));
});

test("only measured spend can close a budget", () => {
  assert.equal(capUse({ measuredUsd: 39, estimatedUsd: 20, assumedUsd: 20 }, 40).spent, false);
  assert.equal(capUse({ measuredUsd: 40, estimatedUsd: 0, assumedUsd: 0 }, 40).spent, true);
});

test("a swarm with no cap says so rather than drawing a full bar", () => {
  const use = capUse(spend, null);
  assert.equal(use.capLine, "no cap set");
  assert.deepEqual(use.segments.map((segment) => segment.ratio), [0, 0, 0]);
  assert.equal(use.spent, false);
});

test("a segment cannot overflow its own track", () => {
  const use = capUse({ measuredUsd: 400, estimatedUsd: 0, assumedUsd: 0 }, 40);
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
    perLeaf: { measuredUsd: 0.5, estimatedUsd: 0.1, assumedUsd: 0.2 },
    typicalLeaves: 10,
  };
  assert.deepEqual(estimateSwarm(template), { measuredUsd: 5, estimatedUsd: 1, assumedUsd: 2 });
  assert.deepEqual(estimateSwarm(template, 2), { measuredUsd: 1, estimatedUsd: 0.2, assumedUsd: 0.4 });
  const line = estimateLine(estimateSwarm(template, 2), 2);
  assert.equal(line, "About $1.00 measured, $0.20 estimated, $0.40 assumed over 2 tasks.");
  assert.ok(!line.includes("$1.60"));
  assert.match(estimateLine(estimateSwarm(template, 1), 1), /over 1 task\./);
});
