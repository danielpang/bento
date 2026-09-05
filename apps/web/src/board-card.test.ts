import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Feature, FeatureSpend } from "@bento/api-client";
import { Board } from "./components/Board.js";

const noop = () => {};

function feature(status: Feature["status"], id = "f1"): Feature {
  return {
    id,
    projectId: "p1",
    title: "Ship the spend chip",
    description: "",
    status,
    currentStageId: "s1",
    branchName: null,
    prNumber: null,
  };
}

function spend(costUsd: number | null, extra: Partial<FeatureSpend> = {}): FeatureSpend {
  return {
    featureId: extra.featureId ?? "f1",
    title: extra.title ?? "Ship the spend chip",
    runs: extra.runs ?? 1,
    costUsd,
    runsWithoutCost: extra.runsWithoutCost ?? 0,
  };
}

function render(features: Feature[], spendByFeature: Record<string, FeatureSpend> = {}) {
  return renderToStaticMarkup(
    createElement(Board, {
      stages: [],
      features,
      profiles: [],
      runStatusByFeature: {},
      lastOutputByFeature: {},
      pulses: {},
      spendByFeature,
      selectedId: null,
      onSelect: noop,
      onMove: noop,
      onFinish: noop,
      onNewCard: noop,
      drawerOpen: false,
    }),
  );
}

test("a completed card shows the reported spend in its meta row", () => {
  const html = render([feature("done")], { f1: spend(4.2) });
  assert.match(html, /class="card-spend"/);
  assert.match(html, /\$4\.20/);
});

test("a completed card with partial coverage marks the figure as a floor", () => {
  const html = render([feature("done")], { f1: spend(1.2, { runsWithoutCost: 1 }) });
  assert.match(html, /\$1\.20\+/);
  assert.match(html, /Some runs reported no cost, so this is a floor\./);
});

test("an in-progress card does not show spend, even when a figure exists", () => {
  const html = render([feature("active")], { f1: spend(4.2) });
  assert.doesNotMatch(html, /card-spend/);
  assert.doesNotMatch(html, /\$4\.20/);
});

test("a cancelled card in the completed lane still shows its spend", () => {
  const html = render([feature("cancelled")], { f1: spend(0.4) });
  assert.match(html, /class="card-spend"/);
  assert.match(html, /\$0\.40/);
});

test("a completed card with no reported cost does not invent a figure", () => {
  const html = render([feature("done")], { f1: spend(null) });
  assert.doesNotMatch(html, /card-spend/);
  assert.doesNotMatch(html, /Not reported/);
});

test("spend sits in the existing meta row next to a PR chip", () => {
  const html = render([{ ...feature("done"), prNumber: 12, prUrl: "https://example.com/pr/12" }], { f1: spend(4.2) });
  assert.match(html, /class="card-meta-end"/);
  assert.match(html, /class="card-spend"[^>]*>\$4\.20/);
  assert.match(html, /PR #12/);
});

test("a card with a description still shows only its title on the board", () => {
  const html = render([
    {
      ...feature("done"),
      title: "Rework the mobile topbar",
      description: "The chrome wraps below 720px. Search for Eircode finds this card.",
    },
  ]);
  assert.match(html, /Rework the mobile topbar/);
  assert.doesNotMatch(html, /The chrome wraps below 720px/);
  assert.doesNotMatch(html, /Eircode/);
  assert.doesNotMatch(html, /card-description/);
});
