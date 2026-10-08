import assert from "node:assert/strict";
import test from "node:test";
import type { BentoClient, Feature, Stage } from "@bento/api-client";

// The drawer imports the GitHub connect dialog, and that module reads
// window while it loads. A test process has none until this.
Object.assign(globalThis, {
  window: {
    location: { origin: "http://localhost" },
    matchMedia: () => ({ matches: false }),
  },
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { FeatureDrawer } = await import("./FeatureDrawer.js");

const stage = (createPr: boolean, id = "build"): Stage => ({
  id,
  pipelineId: "pipe",
  position: 0,
  name: "Build",
  slug: "build",
  description: "",
  defaultAgentProfileId: null,
  gateType: "manual",
  gateCriteria: [],
  createPr,
});

function card(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "f1",
    projectId: "p1",
    title: "Ship the drawer action",
    description: "",
    status: "active",
    currentStageId: "build",
    branchName: "bento/ship-the-drawer-action",
    prNumber: null,
    ...overrides,
  };
}

/** The next-step actions, before More actions. That is where Create PR belongs. */
function nextStep(html: string): string {
  const start = html.indexOf('class="section feature-next-step"');
  const end = html.indexOf('class="feature-more-actions"');
  assert.ok(start >= 0 && end > start, "the drawer renders its next-step actions");
  return html.slice(start, end);
}

function drawer(feature: Feature, stages: Stage[]) {
  return renderToStaticMarkup(
    createElement(FeatureDrawer, {
      client: {} as BentoClient,
      feature,
      stages,
      profiles: [],
      runsVersion: 0,
      onClose: () => {},
      onChanged: () => {},
      onDeleting: () => {},
      onDeleted: () => {},
      onSelectFeature: () => {},
      onEvent: () => {},
    }),
  );
}

test("Create PR is an action when the stage opens pull requests", () => {
  const actions = nextStep(drawer(card(), [stage(true)]));
  assert.match(actions, />Create PR<\/button>/);
  assert.doesNotMatch(actions, /disabled=""[^>]*>Create PR/);
});

test("a finished card on a publishing stage still offers Create PR", () => {
  const actions = nextStep(drawer(card({ status: "done" }), [stage(true)]));
  assert.match(actions, />Reopen<\/button>/);
  assert.match(actions, />Create PR<\/button>/);
});

test("Create PR stays out of the actions when the stage toggle is off", () => {
  const actions = nextStep(drawer(card(), [stage(false)]));
  assert.doesNotMatch(actions, />Create PR<\/button>/);
});

test("Create PR follows the card's stage, not another stage's toggle", () => {
  const actions = nextStep(
    drawer(card({ currentStageId: "plan" }), [stage(false, "plan"), stage(true, "build")]),
  );
  assert.doesNotMatch(actions, />Create PR<\/button>/);
});

test("a backlog card has no Create PR action", () => {
  const actions = nextStep(drawer(card({ currentStageId: null, branchName: null }), [stage(true)]));
  assert.doesNotMatch(actions, />Create PR<\/button>/);
});

test("Create PR explains why it is waiting when the card has no branch yet", () => {
  const actions = nextStep(drawer(card({ branchName: null }), [stage(true)]));
  assert.match(actions, /title="Run an agent on this card first\."[^>]*>Create PR<\/button>/);
});
