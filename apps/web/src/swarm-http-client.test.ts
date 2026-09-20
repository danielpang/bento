import assert from "node:assert/strict";
import test from "node:test";
import {
  httpSwarmApi,
  swarmApi,
  toDetail,
  toSummary,
  toTemplate,
  type WireDetail,
  type WireSwarm,
  type WireSwarmRow,
  type WireTask,
} from "./swarm/client.js";

/**
 * The console against the routes the server actually serves.
 *
 * Written as calls and the requests they make, because that is the
 * failure this pins: a client aimed at endpoints nobody wrote answers
 * 404 to everything, and a console wired to fixtures instead shows a
 * stranger's swarms as your own and does nothing when you press
 * anything.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch that records what was asked for and answers with `reply`. */
function fetchStub(reply: unknown = {}, status = 200) {
  const calls: Call[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    } as Response;
  }) as typeof fetch;
  return { calls, doFetch };
}

const wireSwarm = (over: Partial<WireSwarm> = {}): WireSwarm => ({
  id: "sw-1",
  projectId: "p1",
  slug: "checkout",
  title: "Checkout rewrite",
  goal: "Replace the checkout.",
  status: "running",
  pausedReason: null,
  branchName: "swarm/checkout",
  templateId: "tpl-1",
  budgetUsd: "40.00",
  maxWorkers: 4,
  timeLimitMin: null,
  spentMeasuredUsd: "5.08",
  spentEstimatedUsd: "0.37",
  spentAssumedUsd: "0.25",
  archivedAt: null,
  lastOpenedAt: null,
  createdAt: "2026-09-04T12:00:00.000Z",
  ...over,
});

const wireTask = (over: Partial<WireTask> = {}): WireTask => ({
  id: "t-1",
  parentId: null,
  position: 0,
  title: "Cart page",
  description: "",
  nodeType: "leaf",
  status: "working",
  attention: null,
  weight: 1,
  assignedRunId: null,
  branchName: null,
  flags: {},
  report: null,
  costMeasuredUsd: "1.50",
  costEstimatedUsd: "0.25",
  costAssumedUsd: "0",
  startedAt: null,
  endedAt: null,
  ...over,
});

test("the console is wired to the server, not to the fixtures", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as Response;
  }) as typeof fetch;
  try {
    const rows = await swarmApi.listSwarms("p1");
    assert.deepEqual(rows, [], "an empty project has no swarms, invented or otherwise");
    assert.deepEqual(asked, ["/api/swarms?projectId=p1"], "it asked the server");
  } finally {
    globalThis.fetch = real;
  }
});

test("the strip is this project's swarms, with the server's own counts as the ring", async () => {
  const rows: WireSwarmRow[] = [
    { ...wireSwarm(), counts: { tasks: 4, done: 1, attention: 0 } },
    {
      ...wireSwarm({ id: "sw-2", title: "Docs", status: "blocked" }),
      counts: { tasks: 0, done: 0, attention: 0 },
    },
  ];
  const { calls, doFetch } = fetchStub(rows);
  const listed = await httpSwarmApi("", doFetch).listSwarms("p 1");

  assert.deepEqual(calls[0], { url: "/api/swarms?projectId=p%201", method: "GET", body: undefined });
  assert.equal(listed[0]!.name, "Checkout rewrite", "the row's title is the swarm's name here");
  assert.equal(listed[0]!.completion, 0.25);
  assert.equal(listed[1]!.completion, 0, "a swarm with no plan is not a divide by zero");
  assert.equal(listed[1]!.status, "waiting", "blocked on the server is waiting for a person here");
});

test("one swarm reads back with its plan, its spend and what is working", async () => {
  const detail: WireDetail = {
    swarm: wireSwarm(),
    tasks: [wireTask(), wireTask({ id: "t-2", attention: "question", status: "blocked" })],
    activeRuns: [
      { id: "r1", role: "worker", status: "running", swarmTaskId: "t-1" },
      { id: "r2", role: "planner", status: "running", swarmTaskId: null },
    ],
  };
  const { calls, doFetch } = fetchStub(detail);
  const read = await httpSwarmApi("", doFetch).getSwarm("sw-1");

  assert.equal(calls[0]!.url, "/api/swarms/sw-1");
  assert.equal(read.swarm.name, "Checkout rewrite");
  assert.deepEqual(read.swarm.spend, { measuredUsd: 5.08, estimatedUsd: 0.37, assumedUsd: 0.25 });
  assert.equal(read.swarm.budgetUsd, 40);
  assert.equal(read.swarm.workers, 4, "the swarm's own ceiling is what the stepper changes");
  assert.equal(read.swarm.workersActive, 1, "the planner is not a worker");
  assert.deepEqual(read.tasks[0]!.cost, { measuredUsd: 1.5, estimatedUsd: 0.25, assumedUsd: 0 });
  assert.equal(read.tasks[0]!.attention, "none");
  assert.equal(read.tasks[1]!.attention, "escalated", "a question wants a person");

  // Nothing is invented for the surfaces the routes do not serve.
  assert.deepEqual(read.landings, []);
  assert.deepEqual(read.ledger, []);
  assert.deepEqual(read.pullRequests, []);
  assert.equal(read.swarm.question, null);
  assert.deepEqual(read.tasks[0]!.commits, []);
  assert.deepEqual(read.tasks[0]!.acceptanceCriteria, []);
});

test("creating a swarm sends what the route takes and nothing else", async () => {
  const { calls, doFetch } = fetchStub(wireSwarm({ status: "planning" }));
  const created = await httpSwarmApi("", doFetch).createSwarm({
    projectId: "p1",
    templateId: "tpl-1",
    name: "Checkout rewrite",
    goal: "Replace the checkout.",
    attachments: [{ name: "notes.md", bytes: 12 }],
    start: { kind: "new-branch", name: "bento/checkout" },
    deliverable: "code",
    budgetUsd: 40,
    workers: 6,
    planOnly: true,
  });

  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "/api/swarms");
  assert.deepEqual(calls[0]!.body, {
    projectId: "p1",
    title: "Checkout rewrite",
    goal: "Replace the checkout.",
    templateId: "tpl-1",
    maxWorkers: 6,
    budgetUsd: 40,
  });
  assert.equal(created.swarm.status, "planning");
  assert.deepEqual(created.tasks, [], "a new swarm has no plan until its planner writes one");
});

test("every control the console offers reaches the route that does it", async () => {
  const { calls, doFetch } = fetchStub(wireSwarm());
  const api = httpSwarmApi("", doFetch);
  await api.pauseSwarm("sw-1");
  await api.resumeSwarm("sw-1");
  await api.stopSwarm("sw-1");
  await api.archiveSwarm("sw-1");
  await api.restoreSwarm("sw-1");
  await api.setWorkers("sw-1", 6);
  await api.answerQuestion("sw-1", "q-1", "Use the new client.");

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST /api/swarms/sw-1/pause",
      // Resuming is starting: one route decides when a swarm may run.
      "POST /api/swarms/sw-1/start",
      "POST /api/swarms/sw-1/cancel",
      "PATCH /api/swarms/sw-1",
      "PATCH /api/swarms/sw-1",
      "PATCH /api/swarms/sw-1",
      "POST /api/swarms/sw-1/messages",
    ],
  );
  assert.deepEqual(calls[3]!.body, { archived: true });
  assert.deepEqual(calls[4]!.body, { archived: false });
  assert.deepEqual(calls[5]!.body, { maxWorkers: 6 });
  assert.deepEqual(calls[6]!.body, { text: "Use the new client." });
  // A status is never patched: the lifecycle routes decide that, and
  // the route refuses a body carrying one.
  assert.ok(
    calls.every((call) => !(call.body && typeof call.body === "object" && "status" in call.body)),
    "no call tries to set a status directly",
  );
});

test("a refusal reaches the person in the server's own words", async () => {
  const { doFetch } = fetchStub({ error: "This swarm has no plan yet, so there is nothing to start." }, 409);
  await assert.rejects(
    () => httpSwarmApi("", doFetch).resumeSwarm("sw-1"),
    /This swarm has no plan yet/,
    "the error is the sentence the server wrote, not its JSON",
  );
});

test("a template carries its ceilings, and claims no cost shape it does not have", () => {
  const template = toTemplate({
    id: "tpl-1",
    name: "Default",
    description: "The planner and worker a swarm uses.",
    maxWorkers: 4,
    budgetUsd: "25.00",
    timeLimitMin: 120,
  });
  assert.equal(template.maxWorkers, 4);
  assert.equal(template.maxBudgetUsd, 25);
  assert.equal(template.timeLimitMin, 120);
  assert.deepEqual(template.tools, [], "nothing on the server says what a tool reports in");
  assert.equal(template.typicalLeaves, 0, "so the dialog draws no estimate rather than a zero");
});

test("a swarm's status is said in the console's words, and a budget stop says so", () => {
  const status = (over: Partial<WireSwarmRow>) =>
    toSummary({ ...wireSwarm(), counts: { tasks: 0, done: 0, attention: 0 }, ...over }).status;
  assert.equal(status({ status: "planning" }), "planning");
  assert.equal(status({ status: "running" }), "running");
  assert.equal(status({ status: "paused", pausedReason: "manual" }), "paused");
  assert.equal(status({ status: "paused", pausedReason: "budget" }), "budget_exhausted");
  assert.equal(status({ status: "blocked" }), "waiting");
  assert.equal(status({ status: "cancelled" }), "stopped");
  assert.equal(status({ status: "done" }), "done");
  assert.equal(status({ status: "failed" }), "failed");
  // A swarm is created planning, so draft is a row nothing writes.
  assert.equal(status({ status: "draft" }), "planning");
});

test("a swarm with no plan and no runs still draws", () => {
  const read = toDetail({ swarm: wireSwarm({ status: "planning" }), tasks: [], activeRuns: [] });
  assert.deepEqual(read.tasks, []);
  assert.equal(read.swarm.workersActive, 0);
  assert.equal(read.swarm.startedAt, null, "the header falls back to when it was created");
});
