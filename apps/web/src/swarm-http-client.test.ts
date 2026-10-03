import assert from "node:assert/strict";
import test from "node:test";
import {
  httpSwarmApi,
  swarmApi,
  toDetail,
  toSummary,
  toSwarm,
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
  plannerProfileId: "planner-1",
  workerProfileId: "worker-1",
  judgeProfileId: null,
  completionCommand: null,
  maxPlanDepth: 1,
  plannerInstructions: null,
  workerInstructions: null,
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
  assert.deepEqual(read.swarm.spend, { measuredUsd: 5.08, estimatedUsd: 0.37, assumedUsd: 0.25 , notionalUsd: 0});
  assert.equal(read.swarm.budgetUsd, 40);
  assert.equal(read.swarm.workers, 4, "the swarm's own ceiling is what the stepper changes");
  assert.equal(read.swarm.workersActive, 1, "the planner is not a worker");
  assert.deepEqual(read.tasks[0]!.cost, { measuredUsd: 1.5, estimatedUsd: 0.25, assumedUsd: 0 , notionalUsd: 0});
  assert.equal(read.tasks[0]!.attention, "none");
  assert.equal(read.tasks[1]!.attention, "question", "the server's own reason, not a severity it was flattened into");

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
    plannerProfileId: "planner-1",
    workerProfileId: "worker-1",
    settings: { judgeProfileId: "judge-1", completionCommand: "pnpm test" },
    name: "Checkout rewrite",
    goal: "Replace the checkout.",
    planSources: [],
    planMode: "goal",
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
    plannerProfileId: "planner-1",
    workerProfileId: "worker-1",
    deliverable: "code",
    judgeProfileId: "judge-1",
    completionCommand: "pnpm test",
    maxWorkers: 6,
    budgetUsd: 40,
  });
  assert.equal(created.swarm.status, "planning");
  assert.deepEqual(created.tasks, [], "a new swarm has no plan until its planner writes one");
});

test("a swarm started from an existing plan sends the plan and the mode, as the route takes them", async () => {
  const { calls, doFetch } = fetchStub(wireSwarm({ status: "planning", planMode: "existing" }));
  const created = await httpSwarmApi("", doFetch).createSwarm({
    projectId: "p1",
    name: "Checkout rewrite",
    goal: "Implement the plan.",
    planSources: [
      { kind: "file", name: "docs/plan.md", content: "# Plan\n\n1. Add the totals helper." },
      { kind: "website", url: "https://example.test/plan" },
    ],
    planMode: "existing",
    start: { kind: "new-branch", name: "bento/checkout" },
    deliverable: "code",
    budgetUsd: null,
    workers: 2,
    planOnly: true,
  });

  assert.deepEqual(calls[0]!.body, {
    projectId: "p1",
    title: "Checkout rewrite",
    goal: "Implement the plan.",
    deliverable: "code",
    maxWorkers: 2,
    planMode: "existing",
    planSources: [
      { kind: "file", name: "docs/plan.md", content: "# Plan\n\n1. Add the totals helper." },
      { kind: "website", url: "https://example.test/plan" },
    ],
  });
  assert.equal(created.swarm.planMode, "existing", "and the row reads back as a swarm built from a plan");
});

test("a detail lists what the planner was handed, with a page's address checked before it becomes a link", async () => {
  const { doFetch } = fetchStub({
    swarm: wireSwarm({ planMode: "existing" }),
    tasks: [],
    activeRuns: [],
    planSources: [
      { id: "ps-1", position: 0, kind: "file", name: "docs/plan.md", url: null, size: 1200 },
      { id: "ps-2", position: 1, kind: "website", name: "The plan", url: "https://example.test/plan", size: 800 },
      { id: "ps-3", position: 2, kind: "website", name: "Bad", url: "javascript:alert(1)", size: 10 },
      { id: "ps-4", position: 3, kind: "file", name: "mockup.png", url: null, mime: "image/png", media: "image", size: 0, hasText: false, byteSize: 4096 },
    ],
  });
  const read = await httpSwarmApi("", doFetch).getSwarm("sw-1");
  assert.equal(read.swarm.planMode, "existing");
  assert.deepEqual(
    read.planSources?.map((source) => [source.name, source.url]),
    [["docs/plan.md", null], ["The plan", "https://example.test/plan"], ["Bad", null], ["mockup.png", null]],
    "a file has no address, a page keeps its http address, and anything else is drawn without a link",
  );
  assert.deepEqual(
    read.planSources?.map((source) => [source.media, source.hasText, source.byteSize, source.contentPath]),
    [
      ["text", true, null, "/api/swarms/sw-1/plan-sources/ps-1/content"],
      ["text", true, null, "/api/swarms/sw-1/plan-sources/ps-2/content"],
      ["text", true, null, "/api/swarms/sw-1/plan-sources/ps-3/content"],
      ["image", false, 4096, "/api/swarms/sw-1/plan-sources/ps-4/content"],
    ],
    "a server from before PDFs and images reads as text, and every source knows where its bytes are served",
  );
});

test("retrying a failed planner reaches its run endpoint", async () => {
  const { calls, doFetch } = fetchStub({ runId: "run-2" }, 201);
  await httpSwarmApi("", doFetch).retryPlanner("sw-1");
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/swarms/sw-1/planner/retry"]);
});

test("stopping a planner leaves the swarm itself running", async () => {
  const { calls, doFetch } = fetchStub({ runId: "run-1", status: "cancelled" });
  await httpSwarmApi("", doFetch).stopPlanner("sw-1");
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/swarms/sw-1/planner/stop"]);
});

test("planner guidance uses the persisted swarm thread and leaves task messages out", async () => {
  const planner = {
    id: "message-1", taskId: null, text: "Make the plan smaller", source: "person", status: "sent",
    runId: "run-2", createdAt: "2026-09-04T12:00:00.000Z",
  } as const;
  const task = { ...planner, id: "message-2", taskId: "task-1" };
  const notice = { ...planner, id: "message-3", source: "system" };
  const listed = fetchStub([planner, task, notice]);
  const rows = await httpSwarmApi("", listed.doFetch).listPlannerMessages("sw-1");
  assert.deepEqual(rows, [planner]);
  assert.deepEqual(listed.calls.map((call) => `${call.method} ${call.url}`), ["GET /api/swarms/sw-1/messages"]);

  const sent = fetchStub({ ...planner, id: "message-4", status: "queued", runId: null }, 201);
  const message = await httpSwarmApi("", sent.doFetch).messagePlanner("sw-1", "Make the plan smaller");
  assert.equal(message.status, "queued");
  assert.deepEqual(sent.calls[0], {
    method: "POST", url: "/api/swarms/sw-1/messages", body: { text: "Make the plan smaller" },
  });
});

test("every control the console offers reaches the route that does it", async () => {
  const { calls, doFetch } = fetchStub(wireSwarm());
  const api = httpSwarmApi("", doFetch);
  await api.pauseSwarm("sw-1");
  await api.resumeSwarm("sw-1");
  await api.stopSwarm("sw-1");
  await api.deleteSwarm("sw-1");
  await api.archiveSwarm("sw-1");
  await api.restoreSwarm("sw-1");
  await api.setWorkers("sw-1", 6);
  await api.answerQuestion("sw-1", "q-1", "Use the new client.");
  await api.markTaskDone("sw-1", "task-9");

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      "POST /api/swarms/sw-1/pause",
      // Resuming is starting: one route decides when a swarm may run.
      "POST /api/swarms/sw-1/start",
      "POST /api/swarms/sw-1/cancel",
      "DELETE /api/swarms/sw-1",
      "PATCH /api/swarms/sw-1",
      "PATCH /api/swarms/sw-1",
      "PATCH /api/swarms/sw-1",
      "POST /api/swarms/sw-1/messages",
      // A task is addressed through the swarm that owns it, which is
      // also how the route reaches it: not yours reads as not there.
      "POST /api/swarms/sw-1/tasks/task-9/done",
    ],
  );
  assert.equal(calls[3]!.body, undefined);
  assert.deepEqual(calls[4]!.body, { archived: true });
  assert.deepEqual(calls[5]!.body, { archived: false });
  assert.deepEqual(calls[6]!.body, { maxWorkers: 6 });
  assert.deepEqual(calls[7]!.body, { text: "Use the new client." });
  // A status is never patched: the lifecycle routes decide that, and
  // the route refuses a body carrying one.
  assert.ok(
    calls.every((call) => !(call.body && typeof call.body === "object" && "status" in call.body)),
    "no call tries to set a status directly",
  );
});

test("a swarm is watched through its own stream, and a reconnect is a refetch", () => {
  const listeners = new Map<string, () => void>();
  let closed = false;
  let opened = "";
  const api = httpSwarmApi("", fetchStub(wireSwarm()).doFetch, (url) => {
    opened = url;
    return {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      close: () => {
        closed = true;
      },
    };
  });

  let events = 0;
  let reconnects = 0;
  const stop = api.streamSwarm("sw-1", () => (events += 1), () => (reconnects += 1));
  assert.equal(opened, "/api/swarms/sw-1/events", "one swarm's stream, not the whole project's board");

  listeners.get("open")!();
  assert.equal(reconnects, 0, "the first open is the subscription, not a reconnection");
  listeners.get("swarm_event")!();
  listeners.get("swarm_event")!();
  assert.equal(events, 2, "every event is a wake, and the caller decides what to refetch");

  // A second open is the stream coming back. Board events are not
  // persisted, so what it missed is gone and only a refetch fills it.
  listeners.get("open")!();
  assert.equal(reconnects, 1);

  stop();
  assert.equal(closed, true, "and leaving the swarm takes the stream with it");
});

test("a console with no EventSource still works, without a stream", () => {
  const api = httpSwarmApi("", fetchStub(wireSwarm()).doFetch, null);
  // Server rendering and the tests take this path: no subscription,
  // no throw, and a stop that is safe to call.
  assert.doesNotThrow(() => api.streamSwarm("sw-1", () => {})());
});

test("a refusal reaches the person in the server's own words", async () => {
  const { doFetch } = fetchStub({ error: "This swarm has no plan yet, so there is nothing to start." }, 409);
  await assert.rejects(
    () => httpSwarmApi("", doFetch).resumeSwarm("sw-1"),
    /This swarm has no plan yet/,
    "the error is the sentence the server wrote, not its JSON",
  );
});

test("a swarm's settings come across from its row, and read as the defaults when absent", () => {
  const set = toSwarm(wireSwarm({ judgeProfileId: "judge-1", maxPlanDepth: 2 })).settings;
  assert.equal(set.judgeProfileId, "judge-1");
  assert.equal(set.maxPlanDepth, 2);
  assert.equal(set.plannerProfileId, "planner-1");

  const { judgeProfileId: _j, maxPlanDepth: _d, completionCommand: _c, ...older } = wireSwarm();
  const defaults = toSwarm(older as WireSwarm).settings;
  assert.equal(defaults.judgeProfileId, null, "a server without the columns ran no final check");
  assert.equal(defaults.maxPlanDepth, 1);
  assert.equal(defaults.completionCommand, null);
});

test("changing settings sends only what changed, with null to clear", async () => {
  const { calls, doFetch } = fetchStub(wireSwarm());
  await httpSwarmApi("", doFetch).updateSettings("sw-1", { judgeProfileId: null, maxPlanDepth: 2, completionCommand: undefined });
  assert.equal(calls[0]!.method, "PATCH");
  assert.equal(calls[0]!.url, "/api/swarms/sw-1");
  assert.deepEqual(calls[0]!.body, { judgeProfileId: null, maxPlanDepth: 2 });

  const quiet = fetchStub(wireSwarm());
  await httpSwarmApi("", quiet.doFetch).updateSettings("sw-1", {});
  assert.equal(quiet.calls.length, 0, "nothing changed, so nothing is sent");
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
  /*
   * A question the swarm itself asked reads as waiting, whatever the
   * tree is doing.
   *
   * ask_user with no task has no leaf to raise attention on, so it
   * records the reason on the swarm and leaves the status alone. Read
   * off the status alone, such a swarm looked like it was simply
   * planning or running, and the one thing it needed (an answer) was
   * nowhere on the board.
   */
  assert.equal(status({ status: "planning", pausedReason: "attention" }), "waiting");
  assert.equal(status({ status: "running", pausedReason: "attention" }), "waiting");
  // And a swarm that is over is over: nothing is waiting for anybody.
  assert.equal(status({ status: "cancelled", pausedReason: "attention" }), "stopped");
  assert.equal(status({ status: "done", pausedReason: "attention" }), "done");
});

test("a swarm with no plan and no runs still draws", () => {
  const read = toDetail({ swarm: wireSwarm({ status: "planning" }), tasks: [], activeRuns: [] });
  assert.deepEqual(read.tasks, []);
  assert.equal(read.swarm.workersActive, 0);
  assert.equal(read.swarm.startedAt, null, "the header falls back to when it was created");
});


test("a swarm's pull requests arrive with their addresses checked", async () => {
  /**
   * The row is written by the completion path, and a swarm is a tree
   * of agents reading repositories all day, so the url on it is not
   * something the console may hand to an anchor unexamined: a
   * `javascript:` href runs on the console's origin with the session
   * that is open. The check is here, at the boundary, so no component
   * has to remember it.
   */
  const detail: WireDetail = {
    swarm: wireSwarm(),
    tasks: [],
    activeRuns: [],
    pullRequests: [
      { id: "pr-1", repoUrl: "https://github.com/acme/app", number: 12, url: "https://github.com/acme/app/pull/12", headSha: "abc" },
      { id: "pr-2", repoUrl: "https://github.com/acme/api", number: 13, url: "javascript:alert(document.cookie)", headSha: null },
    ],
  };
  const { doFetch } = fetchStub(detail);
  const read = await httpSwarmApi("", doFetch).getSwarm("sw-1");

  assert.equal(read.pullRequests.length, 2, "a refused address is still a pull request that exists");
  assert.equal(read.pullRequests[0]!.url, "https://github.com/acme/app/pull/12");
  assert.equal(read.pullRequests[0]!.number, 12);
  assert.equal(read.pullRequests[1]!.url, null, "nothing but http and https becomes an href");
  assert.equal(read.pullRequests[1]!.number, 13, "and the rest of the row is untouched");
});
