import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureSpend } from "@bento/api-client";
import { SpendPage, SwarmSpendTable } from "./components/SpendPage.js";
import {
  compareFeatureSpend,
  formatCardSpend,
  formatFeatureSpend,
  spendHeadline,
} from "./components/spend-format.js";

function row(title: string, costUsd: number | null, extra: Partial<FeatureSpend> = {}): FeatureSpend {
  return { featureId: title, title, runs: extra.runs ?? 1, costUsd, runsWithoutCost: extra.runsWithoutCost ?? 0 };
}

test("highest measured spend sorts first, and unmeasured cards sink", () => {
  const cards = [row("quiet", null), row("cheap", 0.1), row("dear", 4.2), row("idle", null, { runs: 0 })];
  const ranked = [...cards].sort((a, b) => compareFeatureSpend(a, b, "spend-desc"));
  assert.deepEqual(
    ranked.map((c) => c.title),
    ["dear", "cheap", "idle", "quiet"],
  );
});

test("ascending spend still leaves unmeasured cards at the bottom", () => {
  const cards = [row("dear", 4.2), row("quiet", null), row("cheap", 0.1)];
  const ranked = [...cards].sort((a, b) => compareFeatureSpend(a, b, "spend-asc"));
  assert.deepEqual(
    ranked.map((c) => c.title),
    ["cheap", "dear", "quiet"],
  );
});

test("title sort is alphabetical and ignores the cost", () => {
  const cards = [row("dear", 4.2), row("cheap", 0.1), row("quiet", null)];
  const ranked = [...cards].sort((a, b) => compareFeatureSpend(a, b, "title-asc"));
  assert.deepEqual(
    ranked.map((c) => c.title),
    ["cheap", "dear", "quiet"],
  );
});

test("a missing cost is not formatted as zero", () => {
  assert.equal(formatFeatureSpend(row("idle", null, { runs: 0 })), "No runs");
  assert.equal(formatFeatureSpend(row("silent", null)), "Not reported");
  assert.equal(formatFeatureSpend(row("partial", 1.2, { runs: 3, runsWithoutCost: 1 })), "$1.20+");
  assert.equal(formatFeatureSpend(row("full", 0.4)), "$0.40");
});

test("a card face prints a figure only when one was reported", () => {
  assert.equal(formatCardSpend(undefined), null);
  assert.equal(formatCardSpend(row("silent", null)), null);
  assert.equal(formatCardSpend(row("partial", 1.2, { runsWithoutCost: 1 })), "$1.20+");
  assert.equal(formatCardSpend(row("full", 0.4)), "$0.40");
});

test("the spend page lists the tools that report a cost and the ones that do not", () => {
  const html = renderToStaticMarkup(
    createElement(SpendPage, {
      client: {
        getUsage: () => Promise.resolve({ totalUsd: 0, totalRuns: 0, runsWithoutCost: 0, byStage: [], byFeature: [] }),
        streamBoard: () => () => {},
      } as never,
      projectId: "p1",
    }),
  );
  assert.match(html, /<dt>Report a cost<\/dt>/);
  assert.match(html, /Claude Code, pi/);
  assert.match(html, /<dt>Report none<\/dt>/);
  assert.match(html, /Codex CLI, Cursor CLI, opencode, Poolside \(pool\)/);
  assert.match(html, /Muse Code/);
  assert.match(html, /floor rather than a full total/);
});

/** One swarm with money on it, and no cards at all. */
const swarmRow = {
  swarmId: "sw-1",
  title: "Rewrite checkout",
  status: "done",
  runs: 21,
  runsWithoutCost: 0,
  measuredUsd: 40,
  estimatedUsd: 0,
  assumedUsd: 0,
  notionalUsd: 0,
};

/**
 * The link off a swarm row has to open that swarm.
 *
 * The console reads which board to show from `board`, and reads
 * nothing at all from `mode`. A row linking to `mode=swarms` therefore
 * landed whoever clicked it on the card board, carrying a swarm id the
 * card board has no use for, and it did so invisibly for anybody whose
 * browser already remembered the swarm view.
 */
test("a swarm row links to the swarm board, by the parameter the console reads", () => {
  const html = renderToStaticMarkup(createElement(SwarmSpendTable, { rows: [swarmRow] }));
  assert.match(html, /href="\/\?board=swarms&amp;swarm=sw-1"/);
  assert.ok(!html.includes("mode=swarms"), "the console never reads a mode parameter");
});

/**
 * The first number on the page cannot disagree with the table under it.
 *
 * The headline counts card runs, and a swarm's runs belong to no card,
 * so a project worked entirely by swarms read "No agent runs yet."
 * directly above a table saying forty dollars.
 *
 * The fix is not to add the swarm money into that total. The tiers are
 * kept apart everywhere precisely so that no one figure stands for a
 * measurement, an estimate, a guess and a list price at once, and the
 * headline is the worst possible place to start. It says what it is
 * counting instead.
 */
test("the headline says which runs it counted, and never denies the swarms", () => {
  assert.equal(spendHeadline({ totalUsd: 4.2, totalRuns: 3, runsWithoutCost: 0 }, 0), "$4.20 across 3 runs on cards.");
  assert.equal(
    spendHeadline({ totalUsd: 4.2, totalRuns: 3, runsWithoutCost: 1 }, 0),
    "$4.20+ across 2 of 3 runs on cards.",
  );
  // No cards, and a swarm that spent forty dollars. The page used to
  // open with "No agent runs yet." directly above it.
  assert.equal(spendHeadline({ totalUsd: 0, totalRuns: 0, runsWithoutCost: 0 }, 21), "No runs on cards yet.");
  // And nothing anywhere is still nothing anywhere.
  assert.equal(spendHeadline({ totalUsd: 0, totalRuns: 0, runsWithoutCost: 0 }, 0), "No agent runs yet.");
});
