import assert from "node:assert/strict";
import test from "node:test";
import { fixtureSwarmApi } from "./swarm/client.js";
import { SWARM_TEMPLATES, generateSwarmTasks, seedSwarms } from "./swarm/fixtures.js";
import { buildSwarmModel } from "./swarm/layout.js";
import { clampWorkers, parseBudget, suggestBranch } from "./components/NewSwarmDialog.js";
import type { NewSwarmInput } from "./swarm/types.js";

/**
 * The boundary the console actually talks to.
 *
 * Not every route is built, so this asserts the shape they answer in
 * and the behaviour the console leans on: the strip's ring is the
 * same rollup the page draws, marking a leaf done moves every ring
 * above it, and a new swarm lands at the end of the strip. Finishing
 * a leaf has a route now, and swarm-http-client.test.ts holds it to
 * this contract; what is left here is the arithmetic, which is the
 * console's own and cheaper to exercise against fixtures than against
 * a database.
 */

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const clock = () => NOW;

function input(over: Partial<NewSwarmInput> = {}): NewSwarmInput {
  return {
    projectId: "p1",
    templateId: "tpl-code",
    name: "Checkout rewrite",
    goal: "Replace the checkout.",
    attachments: [],
    start: { kind: "new-branch", name: "bento/checkout-rewrite" },
    deliverable: "code",
    budgetUsd: 40,
    workers: 4,
    planOnly: false,
    ...over,
  };
}

test("a tab's ring is the rollup of the tree behind it, not a second figure", async () => {
  const api = fixtureSwarmApi(clock);
  const rows = await api.listSwarms("p1");
  for (const row of rows) {
    const detail = await api.getSwarm(row.id);
    const model = buildSwarmModel(detail.tasks, { now: NOW });
    assert.equal(row.completion, model.root.completion, row.id);
  }
});

test("the seeded strip is ordered by creation, with an archived one in it", async () => {
  const api = fixtureSwarmApi(clock);
  const rows = await api.listSwarms("p1");
  const times = rows.map((row) => Date.parse(row.createdAt));
  assert.deepEqual([...times].sort((a, b) => a - b), times);
  assert.equal(rows.filter((row) => row.archivedAt !== null).length, 1);
  assert.ok(rows.some((row) => row.status === "running"));
  assert.ok(rows.some((row) => row.status === "planning"));
  assert.ok(rows.some((row) => row.status === "done"));
});

test("marking a leaf done moves the ring above it, all the way to the root", async () => {
  const api = fixtureSwarmApi(clock);
  await api.listSwarms("p1");
  const before = await api.getSwarm("sw-checkout");
  const beforeModel = buildSwarmModel(before.tasks, { now: NOW });
  const beforeRoot = beforeModel.root.completion;
  const beforePlan = beforeModel.byId.get("t-ui")!.completion;

  await api.markTaskDone("sw-checkout", "t-ui-errors");

  const after = await api.getSwarm("sw-checkout");
  const afterModel = buildSwarmModel(after.tasks, { now: NOW });
  assert.ok(afterModel.root.completion > beforeRoot);
  assert.ok(afterModel.byId.get("t-ui")!.completion > beforePlan);
  // And the strip agrees, because it reads the same rollup.
  const rows = await api.listSwarms("p1");
  assert.equal(rows.find((row) => row.id === "sw-checkout")!.completion, afterModel.root.completion);
});

test("a new swarm lands at the end of the strip, planning, with the goal it was given", async () => {
  const api = fixtureSwarmApi(clock);
  const before = await api.listSwarms("p1");
  const created = await api.createSwarm(input({ name: "Docs sweep", goal: "Tidy the docs." }));
  const after = await api.listSwarms("p1");

  assert.equal(after.length, before.length + 1);
  assert.equal(after[after.length - 1]!.id, created.swarm.id);
  assert.equal(created.swarm.status, "planning");
  assert.equal(created.swarm.goal, "Tidy the docs.");
  assert.equal(created.swarm.workers, 4);
  assert.equal(created.swarm.budgetUsd, 40);
  // Nothing planned yet, so the ring starts empty rather than full.
  assert.equal(buildSwarmModel(created.tasks, { now: NOW }).root.completion, 0);
});

test("pausing, stopping and archiving are the states the header reads back", async () => {
  const api = fixtureSwarmApi(clock);
  await api.listSwarms("p1");
  await api.pauseSwarm("sw-checkout");
  assert.equal((await api.getSwarm("sw-checkout")).swarm.status, "paused");
  assert.equal((await api.getSwarm("sw-checkout")).swarm.pausedReason, "manual");
  await api.resumeSwarm("sw-checkout");
  assert.equal((await api.getSwarm("sw-checkout")).swarm.status, "running");
  await api.stopSwarm("sw-checkout");
  assert.equal((await api.getSwarm("sw-checkout")).swarm.status, "stopped");
  await api.archiveSwarm("sw-checkout");
  assert.notEqual((await api.getSwarm("sw-checkout")).swarm.archivedAt, null);
  await api.restoreSwarm("sw-checkout");
  assert.equal((await api.getSwarm("sw-checkout")).swarm.archivedAt, null);
});

test("the worker count is held inside the template's own ceiling", async () => {
  const api = fixtureSwarmApi(clock);
  await api.listSwarms("p1");
  await api.setWorkers("sw-checkout", 99);
  assert.equal((await api.getSwarm("sw-checkout")).swarm.workers, 8);
  await api.setWorkers("sw-checkout", 0);
  assert.equal((await api.getSwarm("sw-checkout")).swarm.workers, 1);
});

test("answering the planner clears the question rather than leaving it on the header", async () => {
  const api = fixtureSwarmApi(clock);
  await api.listSwarms("p1");
  const before = await api.getSwarm("sw-checkout");
  assert.notEqual(before.swarm.question, null);
  await api.answerQuestion("sw-checkout", before.swarm.question!.id, "Use the new client.");
  const after = await api.getSwarm("sw-checkout");
  assert.equal(after.swarm.question, null);
  assert.equal(after.swarm.status, "running");
});

test("a swarm this project does not have is an error, not an empty page", async () => {
  const api = fixtureSwarmApi(clock);
  await assert.rejects(() => api.getSwarm("sw-nobody"), /not found/);
});

test("the seeded fixtures include a swarm large enough to be a real plan", () => {
  const seeded = seedSwarms("p1", NOW);
  const big = seeded.find((detail) => detail.swarm.id === "sw-migration")!;
  assert.equal(big.tasks.length, 200);
  const model = buildSwarmModel(big.tasks, { now: NOW });
  assert.equal(model.nodes.length, 200);
  assert.ok(model.root.totalLeaves > 0);
  // Generated deterministically, so two builds are the same plan.
  assert.deepEqual(generateSwarmTasks(20).map((t) => t.id), generateSwarmTasks(20).map((t) => t.id));
});

test("every template names both models and a tier for every tool", () => {
  for (const template of SWARM_TEMPLATES) {
    assert.ok(template.plannerModel.length > 0, template.id);
    assert.ok(template.workerModel.length > 0, template.id);
    assert.ok(template.tools.length > 0, template.id);
    for (const tool of template.tools) {
      assert.ok(["measured", "estimated", "assumed"].includes(tool.tier), `${template.id}:${tool.name}`);
    }
    assert.ok(template.maxWorkers >= 1, template.id);
  }
});

test("a swarm's branch is suggested from its name, and a budget is a number or nothing", () => {
  assert.equal(suggestBranch("Checkout rewrite"), "bento/checkout-rewrite");
  assert.equal(suggestBranch("  Fix the API!  "), "bento/fix-the-api");
  assert.equal(suggestBranch(""), "");
  assert.equal(parseBudget(""), null);
  assert.equal(parseBudget("$40"), 40);
  assert.equal(parseBudget("40.50"), 40.5);
  // A typed zero or a typo is no cap, never a swarm that cannot spend.
  assert.equal(parseBudget("0"), null);
  assert.equal(parseBudget("lots"), null);
  assert.equal(clampWorkers(12, 8), 8);
  assert.equal(clampWorkers(0, 8), 1);
  assert.equal(clampWorkers(Number.NaN, 8), 1);
  assert.equal(clampWorkers(3.4, 8), 3);
});

test("a fixture template survives a create, an edit and a delete, with ids that do not repeat", async () => {
  /**
   * The panel finds a template by id for every edit and delete, so an
   * id that repeats is an edit that lands on the wrong row. The old
   * scheme numbered from the list's length, which repeats as soon as
   * anything is deleted.
   */
  const api = fixtureSwarmApi(clock);
  const seeded = await api.listTemplates();

  const first = await api.createTemplate({
    name: "Wide",
    description: "Many workers",
    maxWorkers: 6,
    budgetUsd: 50,
    timeLimitMin: null,
  });
  const second = await api.createTemplate({
    name: "Narrow",
    description: "One worker",
    maxWorkers: 1,
    budgetUsd: null,
    timeLimitMin: 30,
  });
  assert.notEqual(first.id, second.id);
  assert.equal(first.maxWorkers, 6);
  assert.equal(first.maxBudgetUsd, 50);
  assert.equal(second.timeLimitMin, 30);
  assert.equal(second.maxBudgetUsd, null, "no cap is null rather than the first fixture's figure");

  await api.deleteTemplate(seeded[0]!.id);
  const third = await api.createTemplate({
    name: "Third",
    description: "",
    maxWorkers: 2,
    budgetUsd: null,
    timeLimitMin: null,
  });
  const ids = (await api.listTemplates()).map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, "a delete must not let the next create repeat an id");
  assert.ok(ids.includes(third.id));

  const renamed = await api.updateTemplate(second.id, { name: "Renamed" });
  assert.equal(renamed.name, "Renamed");
  assert.equal(renamed.maxWorkers, 1, "an edit that says only a name leaves the ceilings alone");
  assert.equal(renamed.timeLimitMin, 30);
});

test("the list a caller holds is not the fixture's own state", async () => {
  const api = fixtureSwarmApi(clock);
  const rows = await api.listTemplates();
  rows[0]!.name = "scribbled on";
  assert.notEqual((await api.listTemplates())[0]!.name, "scribbled on");
});

test("a swarm saved as a template keeps its own ceilings over the template's", async () => {
  const api = fixtureSwarmApi(clock);
  const swarms = await api.listSwarms("p1");
  const swarmId = swarms[0]!.id;
  const detail = await api.getSwarm(swarmId);

  await api.setWorkers(swarmId, 5);
  const after = await api.getSwarm(swarmId);
  const saved = await api.saveSwarmAsTemplate(swarmId, "From a swarm");

  assert.equal(saved.name, "From a swarm");
  assert.equal(saved.maxWorkers, after.swarm.workers, "the swarm's number, not the template's");
  assert.match(saved.description, new RegExp(detail.swarm.name));
  assert.ok((await api.listTemplates()).some((row) => row.id === saved.id));
});
