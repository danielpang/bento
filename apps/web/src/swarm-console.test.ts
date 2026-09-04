import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BetaTestersScope } from "./beta.js";
import { BoardModeToggle } from "./components/BoardModeToggle.js";
import { SwarmEmpty, SwarmStrip } from "./components/SwarmStrip.js";
import { SwarmTree } from "./components/SwarmTree.js";
import { SwarmOutline } from "./components/SwarmOutline.js";
import { SwarmNodeDrawer } from "./components/SwarmNodeDrawer.js";
import { SwarmPage } from "./components/SwarmPage.js";
import { modeSurfaces } from "./swarm/plan.js";
import { seedSwarms } from "./swarm/fixtures.js";
import { buildSwarmModel } from "./swarm/layout.js";
import type { SwarmSummary, SwarmTask } from "./swarm/types.js";
import { readFileSync, readdirSync } from "node:fs";

/**
 * What the swarm console actually puts on the screen.
 *
 * Rendered to markup rather than driven in a browser, the way the
 * rest of this suite works. These cover the parts a person can see
 * and the two rules that must hold whatever the agent wrote: text is
 * text, and no dash reaches a reader.
 */

function tasks(): SwarmTask[] {
  const base = (
    id: string,
    parentId: string | null,
    kind: "plan" | "leaf",
    status: SwarmTask["status"],
    extra: Partial<SwarmTask> = {},
  ): SwarmTask => ({
    id,
    parentId,
    position: extra.position ?? 0,
    title: extra.title ?? id,
    description: extra.description ?? "",
    kind,
    status,
    attention: extra.attention ?? "none",
    weight: extra.weight ?? 1,
    assignedRunId: null,
    branchName: extra.branchName ?? null,
    cost: extra.cost ?? { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 },
    flags: extra.flags ?? {},
    report: extra.report ?? null,
    acceptanceCriteria: extra.acceptanceCriteria ?? [],
    startedAt: extra.startedAt ?? null,
    endedAt: extra.endedAt ?? null,
    commits: extra.commits ?? [],
  });
  return [
    base("root", null, "plan", "working", { title: "Ship the new checkout" }),
    base("shipped", "root", "plan", "done", { title: "Cart", position: 0 }),
    base("s1", "shipped", "leaf", "done", { title: "Line item totals", position: 0 }),
    base("slow", "root", "leaf", "working", {
      title: "Refund path",
      position: 1,
      attention: "long_running",
      cost: { measuredUsd: 0.5, estimatedUsd: 0.2, assumedUsd: 0 },
      startedAt: new Date(0).toISOString(),
    }),
  ];
}

const model = buildSwarmModel(tasks(), { now: 60 * 60 * 1000 });

function summary(id: string, over: Partial<SwarmSummary> = {}): SwarmSummary {
  return {
    id,
    projectId: "p1",
    name: over.name ?? id,
    status: over.status ?? "running",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: over.archivedAt ?? null,
    lastOpenedAt: null,
    completion: over.completion ?? 0.5,
  };
}

/** Dashes are banned in user facing copy, so no rendering may carry one. */
function assertNoDashes(html: string, where: string) {
  assert.ok(!html.includes("—"), `em dash in ${where}`);
  assert.ok(!html.includes("–"), `en dash in ${where}`);
}

test("the strip orders swarms by creation with the newest last", () => {
  const html = renderToStaticMarkup(
    createElement(SwarmStrip, {
      swarms: [
        summary("b", { name: "Second", createdAt: "2026-02-01T00:00:00.000Z" }),
        summary("a", { name: "First", createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
      selectedId: "a",
      onSelect: () => {},
      onNew: () => {},
      onRestore: () => {},
    }),
  );
  assert.ok(html.indexOf("First") < html.indexOf("Second"));
  // New swarm sits at the end, where the newest one is.
  assert.ok(html.indexOf("Second") < html.indexOf("New swarm"));
  // The selected tab is the marked one, and carries a ring and a dot.
  assert.match(html, /class="tab tab-on swarm-tab"[^>]*data-tab="a"/);
  assert.match(html, /aria-label="50% done"/);
  assert.match(html, /class="dot" data-state="running"/);
  assertNoDashes(html, "the strip");
});

test("archived swarms fold into an overflow rather than crowding the strip", () => {
  const html = renderToStaticMarkup(
    createElement(SwarmStrip, {
      swarms: [
        summary("live", { name: "Checkout" }),
        summary("old", { name: "Queue spike", archivedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      selectedId: "live",
      onSelect: () => {},
      onNew: () => {},
      onRestore: () => {},
    }),
  );
  assert.match(html, /Archived/);
  // Folded away: the archived swarm's name is not a tab in the row.
  assert.ok(!html.includes("Queue spike"));
  assert.match(html, /swarm-tab-count">1</);
});

test("an archived swarm that is open keeps its place in the strip", () => {
  const html = renderToStaticMarkup(
    createElement(SwarmStrip, {
      swarms: [summary("old", { name: "Queue spike", archivedAt: "2026-03-01T00:00:00.000Z" })],
      selectedId: "old",
      onSelect: () => {},
      onNew: () => {},
      onRestore: () => {},
    }),
  );
  assert.match(html, /data-tab="old"/);
  assert.match(html, /data-archived/);
});

test("a project with no swarms offers exactly one action", () => {
  const html = renderToStaticMarkup(createElement(SwarmEmpty, { onNew: () => {} }));
  assert.equal(html.match(/<button/g)?.length, 1);
  assert.match(html, /New swarm/);
  assertNoDashes(html, "the empty state");
});

test("the tree draws a card per visible node, at the position the model gave it", () => {
  const html = renderToStaticMarkup(
    createElement(SwarmTree, { model, selectedId: null, onSelect: () => {}, onToggle: () => {} }),
  );
  assert.match(html, /Ship the new checkout/);
  assert.match(html, /Refund path/);
  // The done subtree is one filled node, and its child is not drawn.
  assert.ok(!html.includes("Line item totals"));
  assert.match(html, /data-collapsed/);
  assert.match(html, /1 done/);
  // Positions come from the layout, in pixels, inset by the stage's
  // own padding: two leaves a pitch apart, the parent centred over
  // them, and each row a pitch below the last.
  assert.match(html, /left:24px;top:160px/);
  assert.match(html, /left:172px;top:160px/);
  assert.match(html, /left:98px;top:24px/);
  // One edge per drawn parent and child, as a bezier.
  assert.equal(html.match(/<path d="M /g)?.length, 2);
  assertNoDashes(html, "the tree");
});

test("the outline lists every node, including the ones the tree folded", () => {
  const html = renderToStaticMarkup(
    createElement(SwarmOutline, { model, selectedId: null, onSelect: () => {} }),
  );
  assert.match(html, /Line item totals/);
  assert.equal(html.match(/class="swarm-row"/g)?.length, 4);
  // Indent is the depth, so the shape survives the flattening.
  assert.match(html, /padding-left:26px/);
  assert.match(html, /padding-left:44px/);
  assertNoDashes(html, "the outline");
});

test("yellow survives the switch between the two views, and the status does not change", () => {
  const tree = renderToStaticMarkup(
    createElement(SwarmTree, { model, selectedId: null, onSelect: () => {}, onToggle: () => {} }),
  );
  const outline = renderToStaticMarkup(
    createElement(SwarmOutline, { model, selectedId: null, onSelect: () => {} }),
  );
  for (const html of [tree, outline]) {
    assert.match(html, /data-attention/);
    assert.match(html, /running long/);
    // Still working: attention is a second axis, not a status.
    assert.match(html, /working/);
  }
  // The long run warning brings the elapsed time with it, in both.
  assert.match(tree, /running long 1h 0m/);
  assert.match(outline, /running long 1h 0m/);
});

test("both views print the same completion for the same node", () => {
  const tree = renderToStaticMarkup(
    createElement(SwarmTree, { model, selectedId: null, onSelect: () => {}, onToggle: () => {} }),
  );
  const outline = renderToStaticMarkup(
    createElement(SwarmOutline, { model, selectedId: null, onSelect: () => {} }),
  );
  // Root: one of two leaves done, evenly weighted.
  assert.equal(model.root.completion, 0.5);
  assert.match(tree, /aria-label="50% done"/);
  assert.match(outline, /aria-label="50% done"/);
  assert.match(outline, />50%</);
});

test("a report is markdown with raw HTML off, and a title is text", () => {
  const nasty = "<img src=x onerror=alert(1)>";
  const task = {
    ...tasks()[3]!,
    title: nasty,
    description: nasty,
    report: `# Heading\n\n${nasty}\n\n[link](https://example.com)`,
    acceptanceCriteria: [nasty],
    flags: { blockedBy: "t-1", attempts: 2 },
    commits: [{ sha: "abc1234def", message: nasty, at: "2026-01-01T00:00:00.000Z" }],
  };
  const html = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task,
      node: model.byId.get("slow")!,
      onClose: () => {},
      onMarkDone: () => {},
    }),
  );
  /*
   * Nothing an agent wrote became a tag. The characters are still
   * there, escaped, which is the point: the payload is readable and
   * inert. Asserting the absence of the string "onerror" would pass
   * for the wrong reason the day somebody dropped the text instead of
   * escaping it.
   */
  assert.ok(!html.includes("<img"));
  assert.ok(!/<\/?(img|script|iframe)\b/i.test(html));
  const escaped = html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) ?? [];
  // Title, description, one criterion, the commit message, and the
  // report body, each carrying it as text.
  assert.ok(escaped.length >= 5, `escaped ${escaped.length} times`);
  // The markdown around it still renders.
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  // Three figures in the drawer too, never one.
  assert.match(html, /measured/);
  assert.match(html, /estimated/);
  assert.match(html, /assumed/);
  assertNoDashes(html, "the drawer");
});

test("the drawer offers marking a leaf done, and never a plan node", () => {
  const leafHtml = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task: tasks()[3]!,
      node: model.byId.get("slow")!,
      onClose: () => {},
      onMarkDone: () => {},
    }),
  );
  assert.match(leafHtml, /Mark done<\/button>/);
  assert.ok(!/disabled=""[^>]*>Mark done/.test(leafHtml));

  const planHtml = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task: tasks()[0]!,
      node: model.byId.get("root")!,
      onClose: () => {},
      onMarkDone: () => {},
    }),
  );
  assert.match(planHtml, /<button class="btn" disabled="">Mark done<\/button>/);
  assert.match(planHtml, /A plan node is finished by its own tasks finishing\./);
});

test("the mode toggle is two segments, and only for a tester", () => {
  const access = { show: true, included: true, canUpgrade: false, prompt: null };
  const off = renderToStaticMarkup(
    createElement(BetaTestersScope, {
      enabled: false,
      children: createElement(BoardModeToggle, { mode: "pipeline", access, onSelect: () => {} }),
    }),
  );
  assert.equal(off, "");

  const on = renderToStaticMarkup(
    createElement(BetaTestersScope, {
      enabled: true,
      children: createElement(BoardModeToggle, { mode: "pipeline", access, onSelect: () => {} }),
    }),
  );
  assert.match(on, /Pipeline/);
  assert.match(on, /Swarms/);
  // Pipeline is the one marked, because it is where everybody starts.
  assert.match(on, /data-on=""[^>]*>Pipeline|Pipeline/);
  assert.match(on, /aria-current="page"/);
  assertNoDashes(on, "the toggle");
});

test("a plan without swarms shows a locked segment, and a plan still loading shows nothing", () => {
  const locked = renderToStaticMarkup(
    createElement(BetaTestersScope, {
      enabled: true,
      children: createElement(BoardModeToggle, {
        mode: "pipeline",
        access: { show: true, included: false, canUpgrade: true, prompt: "Swarms are not on the Pro plan." },
        onSelect: () => {},
      }),
    }),
  );
  assert.match(locked, /data-locked/);
  assert.match(locked, /Not on this plan/);

  const hidden = renderToStaticMarkup(
    createElement(BetaTestersScope, {
      enabled: true,
      children: createElement(BoardModeToggle, {
        mode: "pipeline",
        access: { show: false, included: false, canUpgrade: false, prompt: null },
        onSelect: () => {},
      }),
    }),
  );
  assert.equal(hidden, "");
});


const NOW = Date.parse("2026-09-04T12:00:00.000Z");

/*
 * The hosted page renders the out of compute banner, which reads
 * sessionStorage in a state initialiser: a browser always has one and
 * node does not. Stubbed rather than worked around, so the assertion
 * below is about the page and not about the environment.
 */
(globalThis as unknown as { sessionStorage: unknown }).sessionStorage ??= {
  getItem: () => null,
  setItem: () => {},
};

function pageHtml(mode: "local" | "multi") {
  const detail = seedSwarms("p1", NOW).find((entry) => entry.swarm.id === "sw-checkout")!;
  return renderToStaticMarkup(
    createElement(SwarmPage, {
      detail,
      model: buildSwarmModel(detail.tasks, { now: NOW }),
      view: "tree",
      onView: () => {},
      selectedId: null,
      onSelect: () => {},
      onToggleNode: () => {},
      surfaces: modeSurfaces(mode),
      actions: {
        onPause: () => {},
        onResume: () => {},
        onStop: () => {},
        onCreatePullRequest: () => {},
        onWorkers: () => {},
        onAnswer: () => {},
      },
    }),
  );
}

test("the header carries the ring, the branch, the elapsed time and the controls", () => {
  const html = pageHtml("multi");
  assert.match(html, /Checkout rewrite/);
  // The 44px ring, with the percentage printed inside it.
  assert.match(html, /width:44px;height:44px/);
  assert.match(html, /class="ring-label"/);
  assert.match(html, /bento\/sw-checkout/);
  // The clock is the real one, so the figure is asserted as a
  // duration in the chip that carries it, not as a fixed string.
  assert.match(html, /title="Since this swarm started">\d+[hms]/);
  assert.match(html, />4 of 11 tasks</);
  assert.match(html, />Pause<\/button>/);
  assert.match(html, />Stop<\/button>/);
  assert.match(html, />Create PR<\/button>/);
  assert.match(html, /aria-label="One more worker"/);
  assert.match(html, /aria-label="One fewer worker"/);
  assertNoDashes(html, "the swarm header");
});

test("the header keeps the three spend figures apart, against the cap", () => {
  const html = pageHtml("multi");
  assert.match(html, />\$5\.08</);
  assert.match(html, />\$0\.37</);
  assert.match(html, />\$0\.25</);
  // 5.08 + 0.37 + 0.25, the number that must never appear.
  assert.ok(!html.includes("$5.70"));
  assert.match(html, /against a \$40\.00 cap/);
  // One track, three fills, each measured on its own.
  assert.equal(html.match(/class="swarm-cap-fill"/g)?.length, 3);
});

test("a planner question is a banner with the reply in it", () => {
  const html = pageHtml("multi");
  assert.match(html, /The planner is asking/);
  assert.match(html, /aria-label="Answer the planner"/);
  assert.match(html, />Send<\/button>/);
});

test("the same page in local mode renders no out of compute banner", () => {
  // The banner's own copy, from OutOfCompute, in neither: in local
  // mode because the component is not rendered at all, and in a
  // hosted one because the plan has not answered. The structural
  // assertion is in swarm-plan.test.ts; this is the page around it.
  assert.ok(!pageHtml("local").includes("agent hours for the period"));
  assert.ok(!pageHtml("multi").includes("agent hours for the period"));
});

test("no dash reaches a reader, in any swarm source", () => {
  const roots = ["src/swarm", "src/components"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(new URL(`../${root}`, import.meta.url))) {
      if (!/^(Swarm|BoardModeToggle|CompletionRing|NewSwarm)/.test(name) && root === "src/components") continue;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const text = readFileSync(new URL(`../${root}/${name}`, import.meta.url), "utf8");
      if (text.includes("\u2014") || text.includes("\u2013")) offenders.push(`${root}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
