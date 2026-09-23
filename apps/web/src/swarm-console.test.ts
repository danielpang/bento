import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BetaTestersScope } from "./beta.js";
import { BoardModeToggle } from "./components/BoardModeToggle.js";
import { MergeQueue } from "./components/MergeQueue.js";
import { SwarmEmpty, SwarmStrip } from "./components/SwarmStrip.js";
import { SwarmTree } from "./components/SwarmTree.js";
import { SwarmOutline } from "./components/SwarmOutline.js";
import { SwarmNodeDrawer } from "./components/SwarmNodeDrawer.js";
import { SwarmArtifacts, SwarmPage } from "./components/SwarmPage.js";
import { ceilingRefusal, reopenEffectLines } from "./components/ReopenDialog.js";
import { isolationWords } from "./components/SwarmTemplatesPanel.js";
import { modeSurfaces } from "./swarm/plan.js";
import { canReopen } from "./swarm/status.js";
import { seedSwarms } from "./swarm/fixtures.js";
import { buildSwarmModel } from "./swarm/layout.js";
import type { SwarmLanding, SwarmStatus, SwarmSummary, SwarmTask } from "./swarm/types.js";
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
    nodeType: "plan" | "leaf",
    status: SwarmTask["status"],
    extra: Partial<SwarmTask> = {},
  ): SwarmTask => ({
    id,
    parentId,
    position: extra.position ?? 0,
    title: extra.title ?? id,
    description: extra.description ?? "",
    nodeType,
    status,
    attention: extra.attention ?? "none",
    weight: extra.weight ?? 1,
    assignedRunId: null,
    agentProfileId: extra.agentProfileId ?? null,
    branchName: extra.branchName ?? null,
    cost: extra.cost ?? { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 , notionalUsd: 0},
    flags: extra.flags ?? {},
    report: extra.report ?? null,
    acceptanceCriteria: extra.acceptanceCriteria ?? [],
    followUpInstruction: extra.followUpInstruction ?? null,
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
      cost: { measuredUsd: 0.5, estimatedUsd: 0.2, assumedUsd: 0 , notionalUsd: 0},
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

  // Given no handler the button stays drawn and disabled, rather than
  // disappearing: a control that vanishes reads as a feature that does
  // not exist, and this one does.
  const unwired = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task: tasks()[3]!,
      node: model.byId.get("slow")!,
      onClose: () => {},
    }),
  );
  assert.match(unwired, /disabled=""[^>]*>Mark done/);
  assert.match(unwired, /not available here/);
});

test("the drawer says what finishing a leaf by hand does to the agent on it", () => {
  const html = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task: tasks()[3]!,
      node: model.byId.get("slow")!,
      onClose: () => {},
      onMarkDone: () => {},
    }),
  );
  // The route stops the run, so the drawer says so before the click
  // rather than leaving a person to notice their agent went quiet.
  assert.match(html, /stops any agent still working it/);
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

test("a pull request the console would not link to is drawn without a link", () => {
  /**
   * `swarm_pull_requests.url` is written on a path agents are on, and
   * an href is not inert: a `javascript:` address in one runs on the
   * console's origin with the session that is open. `client.ts` nulls
   * anything that is not http or https, and this is the other half of
   * that: the chip has to still draw, because a pull request nobody
   * can see is worse than one nobody can click.
   */
  const detail = seedSwarms("p1", NOW).find((entry) => entry.swarm.id === "sw-api")!;
  const withRefused = {
    ...detail,
    pullRequests: [
      { id: "pr-good", repoUrl: "github.com/acme/app", number: 12, url: "https://github.com/acme/app/pull/12", headSha: null },
      { id: "pr-bad", repoUrl: "github.com/acme/api", number: 13, url: null, headSha: null },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(SwarmPage, {
      detail: withRefused,
      model: buildSwarmModel(withRefused.tasks, { now: NOW }),
      view: "tree",
      onView: () => {},
      selectedId: null,
      onSelect: () => {},
      onToggleNode: () => {},
      surfaces: modeSurfaces("multi"),
      actions: {
        onPause: () => {},
        onResume: () => {},
        onStop: () => {},
        onReopen: () => {},
        onArchive: () => {},
        onRestore: () => {},
        onWorkers: () => {},
        onAnswer: () => {},
      },
    }),
  );

  assert.match(html, /href="https:\/\/github\.com\/acme\/app\/pull\/12"/, "the real one is a link");
  assert.match(html, /github\.com\/acme\/api #13/, "the refused one is still shown");
  assert.equal(
    html.split("swarm-prs")[1]?.includes("javascript:"),
    false,
    "and nothing that is not an address reached an href",
  );
  // One anchor in the row, not two: the refused chip is a span.
  const row = html.split('class="swarm-prs"')[1]?.split("</div>")[0] ?? "";
  assert.equal((row.match(/<a /g) ?? []).length, 1);
});

test("a node draws the commits and the history the drawer was given, not the plan's", () => {
  /**
   * The commits come from git, through the node route, because landing
   * rebases a worker's branch and every sha changes: a list carried on
   * the plan row would name commits no branch has. The history is what
   * makes a resolver visible at all, since a conflict puts a second
   * agent on a leaf and nothing else on the node says so.
   */
  const model = buildSwarmModel(tasks(), { now: NOW });
  const task = tasks().find((row) => row.id === "slow")!;
  const html = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task,
      node: model.byId.get("slow")!,
      detail: {
        taskId: "slow",
        commits: [
          { sha: "9f2c1abdeadbeef", message: "Refund the last capture", at: "2026-01-01T00:00:00.000Z", repository: "api" },
        ],
        events: [
          {
            id: "ev-1",
            kind: "assigned",
            at: "2026-01-01T00:00:00.000Z",
            fromStatus: "open",
            toStatus: "assigned",
            runId: null,
            detail: null,
          },
          {
            id: "ev-2",
            kind: "attention_raised",
            at: "2026-01-01T01:00:00.000Z",
            fromStatus: null,
            toStatus: null,
            runId: "11112222-3333-4444-5555-666677778888",
            detail: { conflict: "shared.txt: both modified\nsecond line", resolver: "started" },
          },
        ],
      },
      onClose: () => {},
    }),
  );

  assert.match(html, /9f2c1ab/, "the sha, shortened");
  assert.match(html, /Refund the last capture/);
  assert.match(html, /Assigned/);
  assert.match(html, /Resolver started/, "the resolver run reads as one, not as an enum");
  assert.match(html, /run 11112222/, "and names the run it served, so the transcript can be found");
  assert.match(html, /shared\.txt: both modified/);
  assert.doesNotMatch(html, /second line/, "one line of git's output, not all of it");
});

test("a node with nothing committed says so rather than saying nothing was pushed", () => {
  const model = buildSwarmModel(tasks(), { now: NOW });
  const task = tasks().find((row) => row.id === "slow")!;
  const html = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task,
      node: model.byId.get("slow")!,
      detail: { taskId: "slow", commits: [], events: [] },
      onClose: () => {},
    }),
  );
  assert.match(html, /No commits carry this task&#x27;s trailer yet/);
});

test("the node composer says where a message goes, and a finished node gets none", () => {
  /**
   * The card composer's rule: the box says whether the words go now or
   * wait. A swarm worker is headless and holds no live session, so the
   * only honest promise is the next agent put on the task.
   */
  const model = buildSwarmModel(tasks(), { now: NOW });
  const working = tasks().find((row) => row.id === "slow")!;
  const live = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task: working,
      node: model.byId.get("slow")!,
      onClose: () => {},
      onMessage: () => {},
    }),
  );
  assert.match(live, /aria-label="Queue a message for this task"/);
  assert.match(live, /cannot hear mid turn/);
  assert.match(live, /given to the next agent put on it/);

  const done = tasks().find((row) => row.id === "s1")!;
  const finished = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, {
      task: done,
      node: model.byId.get("s1")!,
      onClose: () => {},
      onMessage: () => {},
    }),
  );
  assert.doesNotMatch(finished, /aria-label="Queue a message for this task"/);
  assert.match(finished, /no agent is coming to read a message/);
});

test("a drawer with no handler for messages draws no composer at all", () => {
  const model = buildSwarmModel(tasks(), { now: NOW });
  const task = tasks().find((row) => row.id === "slow")!;
  const html = renderToStaticMarkup(
    createElement(SwarmNodeDrawer, { task, node: model.byId.get("slow")!, onClose: () => {} }),
  );
  assert.doesNotMatch(html, /Queue a message/);
});

test("a template says where its agents work, because a deployment can refuse it", () => {
  /**
   * The shape is recorded on the template rather than read off the
   * driver, so it is a thing a person chose and a thing a deployment
   * can decline. Somebody reading this panel is the person who would
   * have to know why a swarm was refused.
   */
  assert.equal(isolationWords("worktree"), "each in a worktree of the repository on the server");
  assert.equal(isolationWords("sandbox"), "each on a machine of its own");
});

function pageHtml(mode: "local" | "multi", status?: SwarmStatus) {
  const seeded = seedSwarms("p1", NOW).find((entry) => entry.swarm.id === "sw-checkout")!;
  const detail = status ? { ...seeded, swarm: { ...seeded.swarm, status } } : seeded;
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
        onReopen: () => {},
        onArchive: () => {},
        onRestore: () => {},
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

test("a finished swarm can be archived from its own page", () => {
  const html = pageHtml("multi", "done");
  assert.match(html, />Reopen<\/button>/);
  assert.match(html, />Archive<\/button>/);
});

test("the header keeps every spend figure apart, against the cap", () => {
  const html = pageHtml("multi");
  assert.match(html, />\$5\.08</);
  assert.match(html, />\$0\.37</);
  assert.match(html, />\$0\.25</);
  // 5.08 + 0.37 + 0.25, the number that must never appear.
  assert.ok(!html.includes("$5.70"));
  assert.match(html, /against a \$40\.00 cap/);
  // One track, one fill per tier, each measured on its own.
  assert.equal(html.match(/class="swarm-cap-fill"/g)?.length, 4);
});

/**
 * The one action a freshly planned swarm needs.
 *
 * A swarm is created in the planning state and stays there until a
 * person says the plan is worth running. The console offered Start
 * only where it offered Resume, which planning is not, so the header
 * showed Pause and nothing else: the swarm could be paused, stopped
 * and re-planned, and never started. Pause stays beside it, because
 * pausing a planner mid plan is still a thing somebody wants.
 */
test("a swarm that has been planned and not started offers Start, beside Pause", () => {
  const html = pageHtml("multi", "planning");
  assert.match(html, />Start<\/button>/);
  assert.match(html, />Pause<\/button>/, "and the planner writing the plan can still be paused");
  assertNoDashes(html, "the header of a planning swarm");

  // Running, paused and finished swarms are unchanged: Start belongs
  // to the one state that has a plan and no permission to run it.
  assert.equal(pageHtml("multi").includes(">Start</button>"), false);
  assert.equal(pageHtml("multi", "paused").includes(">Start</button>"), false);
  assert.match(pageHtml("multi", "paused"), />Resume<\/button>/);
  assert.equal(pageHtml("multi", "done").includes(">Start</button>"), false);
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

/* ------------------------------------------------------------------ *
 * The merge queue.
 * ------------------------------------------------------------------ */

function landing(overrides: Partial<SwarmLanding> = {}): SwarmLanding {
  return {
    id: "ld",
    taskId: "t-1",
    branchName: "swarm/checkout-aaaa1111",
    position: 0,
    status: "queued",
    attempt: 0,
    error: null,
    resolverRunId: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function queueHtml(landings: SwarmLanding[]): string {
  return renderToStaticMarkup(createElement(MergeQueue, { landings, tasks: tasks() }));
}

test("the merge queue says what is landing, what is waiting, and what went in", () => {
  const html = queueHtml([
    landing({ id: "a", taskId: "t-api", status: "landed", attempt: 1, endedAt: "2026-01-01T10:00:00.000Z" }),
    landing({ id: "b", taskId: "t-web", status: "landing", attempt: 1, position: 1 }),
    landing({ id: "c", taskId: "t-docs", status: "queued", position: 2 }),
  ]);
  assert.match(html, /Merge queue/);
  assert.match(html, /Landing/);
  assert.match(html, /Waiting/);
  assert.match(html, /Landed/);
  assert.match(html, /1 waiting, one branch at a time/);
  assertNoDashes(html, "the merge queue");
});

test("every landing status draws a tone the stylesheet actually defines", () => {
  /**
   * A tone name with no rule behind it draws as the default grey,
   * silently, so a conflict and a queued row would be the same dot. The
   * six here are the board's own, and the stylesheet is read rather
   * than assumed.
   */
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const statuses: SwarmLanding["status"][] = ["queued", "landing", "landed", "conflicted", "failed", "cancelled"];
  for (const status of statuses) {
    const html = queueHtml([landing({ status })]);
    const tone = /class="dot" data-state="([a-z]+)"/.exec(html)?.[1];
    assert.ok(tone, `${status} draws a dot`);
    const defined = tone === "idle" || css.includes(`.dot[data-state="${tone}"]`);
    assert.ok(defined, `${status} draws as "${tone}", which the stylesheet does not define`);
  }
});

test("what git said about a conflict is printed as text, and only while it stands", () => {
  const conflict = queueHtml([
    landing({ status: "conflicted", attempt: 2, error: "CONFLICT (content): Merge conflict in <script>x</script>" }),
  ]);
  // Agent adjacent output, escaped by React rather than trusted.
  assert.ok(!conflict.includes("<script>x</script>"));
  assert.match(conflict, /&lt;script&gt;/);
  assert.match(conflict, /try 2/);
  assert.match(conflict, /nothing else lands until this is settled/);

  // A landed row's error is history, and printing it would read as a
  // failure on work that is in.
  const landed = queueHtml([landing({ status: "landed", error: "an earlier attempt said this" })]);
  assert.ok(!landed.includes("an earlier attempt said this"));
});

test("a conflict nobody is on says the queue is still asking, not that it gave up", () => {
  /**
   * The words have to match what the server does. A conflict with no
   * resolver named is not a conflict the queue has abandoned: an agent
   * is asked for on every pass, and the ordinary reason there is none
   * yet is a team with no agent hours left for the moment. The panel
   * said "nothing is reconciling this branch", which read as a dead end
   * and sent people to cancel the swarm.
   */
  const waiting = queueHtml([landing({ status: "conflicted", error: "CONFLICT (content) in one file" })]);
  assert.match(waiting, /No agent is on this branch yet/);
  assert.match(waiting, /asked for each time the swarm is reconciled/);
  assert.ok(!waiting.includes("Nothing is reconciling"));

  const working = queueHtml([
    landing({ status: "conflicted", resolverRunId: "run-1", error: "CONFLICT (content) in one file" }),
  ]);
  assert.match(working, /An agent is reconciling this branch/);
  assertNoDashes(`${waiting}${working}`, "the merge queue's conflict note");
});

test("a swarm with nothing accepted yet says so rather than drawing an empty list", () => {
  const html = queueHtml([]);
  assert.match(html, /Nothing has been accepted yet/);
  assert.ok(!html.includes("swarm-queue-row"));
});

test("no dash reaches a reader, in any swarm source", () => {
  const roots = ["src/swarm", "src/components"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(new URL(`../${root}`, import.meta.url))) {
      if (!/^(Swarm|BoardModeToggle|CompletionRing|NewSwarm|MergeQueue|Reopen)/.test(name) && root === "src/components") continue;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const text = readFileSync(new URL(`../${root}/${name}`, import.meta.url), "utf8");
      if (text.includes("\u2014") || text.includes("\u2013")) offenders.push(`${root}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

/* ---------------------------------------------------------------- *
 * Reopening a swarm: the follow up, in both views and in the dialog.
 * ---------------------------------------------------------------- */

/** A tree with a follow up subtree in it, as a reopen leaves one. */
function reopenedTasks(): SwarmTask[] {
  const base = tasks();
  const first = base[0]!;
  return [
    ...base,
    {
      ...first,
      id: "t-follow",
      parentId: null,
      position: 9,
      nodeType: "plan",
      status: "working",
      attention: "none",
      title: "Follow up 1",
      description: "Address the review comments on the totals module.",
      followUpInstruction: "Address the review comments on the totals module.",
      report: null,
      commits: [],
    },
    {
      ...first,
      id: "t-follow-leaf",
      parentId: "t-follow",
      position: 0,
      nodeType: "leaf",
      status: "working",
      attention: "none",
      title: "Rename the totals helper",
      description: "",
      followUpInstruction: null,
      report: null,
      commits: [],
    },
  ];
}

test("a follow up subtree is marked in the tree and in the outline, and says what it was asked for", () => {
  /**
   * The point of the mark is that a person opening a reopened swarm
   * can tell the first pass from what the review asked for without
   * reading every title. The instruction itself is printed once, on
   * the node the reopen made: twenty copies of one sentence is not a
   * label.
   */
  const model = buildSwarmModel(reopenedTasks(), { now: NOW });
  const root = model.byId.get("t-follow")!;
  const leaf = model.byId.get("t-follow-leaf")!;
  assert.equal(root.followUp?.rootId, "t-follow");
  assert.equal(leaf.followUp?.rootId, "t-follow", "the mark reaches the whole subtree");
  assert.equal(model.nodes[0]?.followUp, null, "and stops at the first pass");

  const tree = renderToStaticMarkup(
    createElement(SwarmTree, { model, selectedId: null, onSelect: () => {}, onToggle: () => {} }),
  );
  assert.equal((tree.match(/data-follow-up/g) ?? []).length, 2, "both nodes of the subtree carry the mark");
  assert.match(tree, /Address the review comments on the totals module\./);

  const outline = renderToStaticMarkup(
    createElement(SwarmOutline, { model, selectedId: null, onSelect: () => {} }),
  );
  assert.equal((outline.match(/data-follow-up/g) ?? []).length, 2, "the outline says the same thing");
  assert.match(outline, /Address the review comments/);
  assertNoDashes(`${tree}${outline}`, "the follow up labels");
});

test("the reopen dialog says what reopening will actually do to the pull requests", () => {
  /**
   * A person choosing between a reopen and a new swarm is choosing on
   * three facts: the branch stays the same, the pull requests that are
   * open are updated rather than joined by a second set, and what
   * landed stays landed. The dialog itself lives behind a portal, so
   * what is held here is the sentences it draws.
   */
  const one = reopenEffectLines({ branchName: "swarm/checkout" }, [
    { id: "pr", repoUrl: "https://github.com/acme/app", number: 12, url: "https://github.com/acme/app/pull/12", headSha: "abc" },
  ], 3);
  assert.match(one[0]!, /carries on swarm\/checkout/);
  assert.ok(!one[0]!.includes("second branch is"), "no second branch is offered");
  assert.match(one[1]!, /acme\/app #12 is updated when the follow up finishes/);
  assert.match(one[1]!, /rather than a second one being opened/);
  assert.match(one[2]!, /3 tasks that landed stay landed/);

  const none = reopenEffectLines({ branchName: null }, [], 0);
  assert.match(none[1]!, /has opened no pull request yet/);
  assert.match(none[2]!, /Nothing has landed through the merge queue yet/);

  const many = reopenEffectLines({ branchName: "swarm/x" }, [
    { id: "a", repoUrl: "https://github.com/acme/app", number: 12, url: null, headSha: null },
    { id: "b", repoUrl: "https://github.com/acme/api", number: 3, url: null, headSha: null },
  ], 1);
  assert.match(many[1]!, /The 2 pull requests it already opened \(acme\/app #12, acme\/api #3\)/);
  assert.match(many[2]!, /The 1 task that landed/);

  assertNoDashes([...one, ...none, ...many].join(" "), "the reopen dialog's sentences");
});

test("the reopen dialog refuses a ceiling that would start nothing, before the server has to", () => {
  /**
   * The server refuses this too, and has to: a swarm put back to
   * running that the coordinator will not spawn on is a board that
   * says it is working and never moves. The dialog asks the same two
   * questions so a person is told while the field is still in front
   * of them.
   */
  const done = { status: "done" as SwarmStatus, budgetUsd: 10, timeLimitMin: null };
  assert.equal(ceilingRefusal(done, 4, 10, null), null, "room under the budget is fine");
  assert.match(ceilingRefusal(done, 10, 10, null) ?? "", /Raise the budget/, "none is not");
  assert.equal(ceilingRefusal(done, 10, 25, null), null, "raising it is the way through");
  assert.equal(ceilingRefusal(done, 4, null, null), null, "and clearing it entirely is allowed");

  const late = { status: "timed_out" as SwarmStatus, budgetUsd: null, timeLimitMin: 60 };
  assert.match(ceilingRefusal(late, 4, null, 60) ?? "", /Raise it, or clear it/);
  assert.equal(ceilingRefusal(late, 4, null, 240), null);
  assert.equal(ceilingRefusal(late, 4, null, null), null);

  assert.match(ceilingRefusal(done, 4, Number.NaN, null) ?? "", /number of dollars/);
  assert.match(ceilingRefusal(done, 4, null, 0) ?? "", /whole number of minutes/);
});

test("Reopen is offered on a swarm that has ended and on nothing else", () => {
  for (const status of ["done", "stopped", "failed", "budget_exhausted", "timed_out"] as SwarmStatus[]) {
    assert.equal(canReopen(status), true, `${status} can be reopened`);
  }
  for (const status of ["planning", "running", "waiting", "paused"] as SwarmStatus[]) {
    assert.equal(canReopen(status), false, `${status} cannot`);
  }
});

test("a document swarm names its deliverable and offers to open it", () => {
  /**
   * The assembled document is what a document swarm was for, so the
   * page says so and puts it first. Nothing here renders it: opening
   * one hands it to the viewer a card's artifacts open in, which is
   * where the rule lives that keeps agent bytes off this origin.
   */
  const artifacts = [
    {
      id: "a1",
      runId: "r1",
      swarmTaskId: null,
      stageSlug: "document",
      stageName: "Document",
      path: "docs/queue-migration.md",
      kind: "markdown" as const,
      mime: "text/markdown",
      size: 900,
      createdAt: "2026-09-04T11:00:00.000Z",
    },
    {
      id: "a2",
      runId: "r2",
      swarmTaskId: "t-1",
      stageSlug: "worker",
      stageName: "Worker",
      path: "artifacts/diagram.png",
      kind: "image" as const,
      mime: "image/png",
      size: 12,
      createdAt: "2026-09-04T10:00:00.000Z",
    },
  ];

  const asDocument = renderToStaticMarkup(
    createElement(SwarmArtifacts, { artifacts, deliverable: "document", onOpen: () => {} }),
  );
  assert.match(asDocument, /The document/);
  assert.match(asDocument, /docs\/queue-migration\.md/);
  assert.match(asDocument, /Assembled from the sections in the plan/);
  assert.match(asDocument, /artifacts\/diagram\.png/, "and whatever else the swarm captured");

  const asCode = renderToStaticMarkup(
    createElement(SwarmArtifacts, { artifacts, deliverable: "code", onOpen: () => {} }),
  );
  assert.match(asCode, /What this swarm produced/);
  assert.ok(!asCode.includes("Assembled from the sections"), "a code swarm has no assembled document");

  // A swarm that produced nothing carries no empty box.
  assert.equal(
    renderToStaticMarkup(createElement(SwarmArtifacts, { artifacts: [], deliverable: "code" })),
    "",
  );
  assertNoDashes(`${asDocument}${asCode}`, "the artifacts panel");
});
