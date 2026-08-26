import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureSpend } from "@bento/api-client";
import { SpendPage } from "./components/SpendPage.js";
import { compareFeatureSpend, formatCardSpend, formatFeatureSpend } from "./components/spend-format.js";

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
  assert.match(html, /floor rather than a full total/);
});
