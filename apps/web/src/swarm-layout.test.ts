import assert from "node:assert/strict";
import test from "node:test";
import {
  COLUMN_PITCH,
  LONG_RUN_WARNING_MS,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_PITCH,
  buildSwarmModel,
  createModelCache,
  formatCompletion,
  outlineRows,
  ringGeometry,
  visibleNodes,
} from "./swarm/layout.js";
import type { SwarmSpend, SwarmTask, TaskStatus } from "./swarm/types.js";

/**
 * The plan's arithmetic.
 *
 * Every number the tree and the outline print comes out of
 * `buildSwarmModel`, so these assert the numbers rather than that
 * something came back: a rollup that agrees between the two views, a
 * collapse rule that never folds the frontier, and a layout that puts
 * a parent over its own children.
 */

function spend(measured = 0, estimated = 0, assumed = 0): SwarmSpend {
  return { measuredUsd: measured, estimatedUsd: estimated, assumedUsd: assumed };
}

let seq = 0;
function node(
  id: string,
  parentId: string | null,
  kind: "plan" | "leaf",
  status: TaskStatus,
  extra: Partial<SwarmTask> = {},
): SwarmTask {
  return {
    id,
    parentId,
    position: extra.position ?? seq++,
    title: extra.title ?? id,
    description: "",
    kind,
    status,
    attention: extra.attention ?? "none",
    weight: extra.weight ?? 1,
    assignedRunId: null,
    branchName: null,
    cost: extra.cost ?? spend(),
    flags: {},
    report: null,
    acceptanceCriteria: [],
    startedAt: extra.startedAt ?? null,
    endedAt: extra.endedAt ?? null,
    commits: [],
  };
}

/** A plan with two children of different weights, one of them done. */
function weighted(): SwarmTask[] {
  return [
    node("root", null, "plan", "working"),
    node("a", "root", "leaf", "done", { weight: 3, cost: spend(1) }),
    node("b", "root", "leaf", "working", { weight: 1, cost: spend(0.25) }),
  ];
}

test("a parent's completion is the weighted share of its leaves that are done", () => {
  const model = buildSwarmModel(weighted(), { now: 0 });
  const root = model.byId.get("root")!;
  assert.equal(root.totalWeight, 4);
  assert.equal(root.doneWeight, 3);
  assert.equal(root.completion, 0.75);
  assert.equal(root.doneLeaves, 1);
  assert.equal(root.totalLeaves, 2);
  // The swarm's own ring is the same figure over every top level node.
  assert.equal(model.root.completion, 0.75);
});

test("weight decides the share, not the count", () => {
  const heavy = buildSwarmModel(weighted(), { now: 0 }).root.completion;
  const even = buildSwarmModel(
    [
      node("root", null, "plan", "working"),
      node("a", "root", "leaf", "done", { weight: 1 }),
      node("b", "root", "leaf", "working", { weight: 1 }),
    ],
    { now: 0 },
  ).root.completion;
  assert.equal(heavy, 0.75);
  assert.equal(even, 0.5);
});

test("only done counts: landed, blocked and failed leave the ring short", () => {
  for (const status of ["landed", "blocked", "failed", "open", "assigned", "working"] as TaskStatus[]) {
    const model = buildSwarmModel(
      [node("root", null, "plan", "working"), node("a", "root", "leaf", status)],
      { now: 0 },
    );
    assert.equal(model.root.completion, 0, status);
  }
  const done = buildSwarmModel(
    [node("root", null, "plan", "working"), node("a", "root", "leaf", "done")],
    { now: 0 },
  );
  assert.equal(done.root.completion, 1);
});

test("a cancelled leaf leaves the rollup rather than holding the ring short", () => {
  const model = buildSwarmModel(
    [
      node("root", null, "plan", "working"),
      node("a", "root", "leaf", "done", { weight: 2 }),
      node("b", "root", "leaf", "cancelled", { weight: 5 }),
    ],
    { now: 0 },
  );
  assert.equal(model.root.totalWeight, 2);
  assert.equal(model.root.totalLeaves, 1);
  assert.equal(model.root.completion, 1);
});

test("costs roll up through the tree and stay in their own tiers", () => {
  const model = buildSwarmModel(
    [
      node("root", null, "plan", "working", { cost: spend(0.5) }),
      node("mid", "root", "plan", "working"),
      node("a", "mid", "leaf", "done", { cost: spend(1, 0.25) }),
      node("b", "mid", "leaf", "working", { cost: spend(0, 0, 0.4) }),
    ],
    { now: 0 },
  );
  assert.deepEqual(model.byId.get("mid")!.cost, { measuredUsd: 1, estimatedUsd: 0.25, assumedUsd: 0.4 });
  assert.deepEqual(model.root.cost, { measuredUsd: 1.5, estimatedUsd: 0.25, assumedUsd: 0.4 });
  // A leaf keeps its own figures; only a parent's are rolled.
  assert.deepEqual(model.byId.get("a")!.cost, { measuredUsd: 1, estimatedUsd: 0.25, assumedUsd: 0 });
});

test("the tree and the outline read the same figures for the same fixture", () => {
  const model = buildSwarmModel(weighted(), { now: 0 });
  const rows = outlineRows(model);
  assert.equal(rows.length, model.nodes.length);
  for (const row of rows) {
    const treeNode = model.byId.get(row.id)!;
    assert.equal(row.completion, treeNode.completion, row.id);
    assert.deepEqual(row.cost, treeNode.cost, row.id);
    assert.equal(row.status, treeNode.status, row.id);
    assert.equal(row.attention, treeNode.attention, row.id);
  }
  // Tree order, not insertion order: a parent is always above its children.
  assert.deepEqual(rows.map((row) => row.id), ["root", "a", "b"]);
});

test("a done subtree collapses to one node and hides its children", () => {
  const model = buildSwarmModel(
    [
      node("root", null, "plan", "working"),
      node("shipped", "root", "plan", "done"),
      node("s1", "shipped", "leaf", "done"),
      node("s2", "shipped", "leaf", "done"),
      node("live", "root", "leaf", "working"),
    ],
    { now: 0 },
  );
  const shipped = model.byId.get("shipped")!;
  assert.equal(shipped.collapsed, true);
  assert.equal(shipped.completion, 1);
  assert.equal(shipped.totalLeaves, 2);
  assert.equal(model.byId.get("s1")!.hidden, true);
  assert.equal(model.byId.get("s2")!.hidden, true);
  assert.deepEqual(visibleNodes(model).map((n) => n.id), ["root", "shipped", "live"]);
  // The outline still lists what the tree folded away.
  assert.equal(outlineRows(model).length, 5);
});

test("the frontier never collapses, however done the rest of it is", () => {
  const base = [
    node("root", null, "plan", "working"),
    node("branch", "root", "plan", "done"),
    node("d1", "branch", "leaf", "done"),
    node("d2", "branch", "leaf", "done"),
  ];
  assert.equal(buildSwarmModel(base, { now: 0 }).byId.get("branch")!.collapsed, true);

  // A worker inside it, and it stays open.
  const working = [...base];
  working[3] = node("d2", "branch", "leaf", "working", { position: 3 });
  assert.equal(buildSwarmModel(working, { now: 0 }).byId.get("branch")!.collapsed, false);

  // Assigned counts as the frontier too: a worker has been given it.
  const assigned = [...base];
  assigned[3] = node("d2", "branch", "leaf", "assigned", { position: 3 });
  assert.equal(buildSwarmModel(assigned, { now: 0 }).byId.get("branch")!.collapsed, false);

  // Done, but yellow: still somebody's to look at, so still open.
  const yellow = [...base];
  yellow[3] = node("d2", "branch", "leaf", "done", { position: 3, attention: "escalated" });
  const model = buildSwarmModel(yellow, { now: 0 });
  assert.equal(model.byId.get("branch")!.collapsed, false);
  assert.equal(model.byId.get("branch")!.completion, 1);
});

test("opening a folded subtree by hand keeps it open", () => {
  const tasks = [
    node("root", null, "plan", "working"),
    node("shipped", "root", "plan", "done"),
    node("s1", "shipped", "leaf", "done"),
  ];
  assert.equal(buildSwarmModel(tasks, { now: 0 }).byId.get("shipped")!.collapsed, true);
  const opened = buildSwarmModel(tasks, { now: 0, expanded: ["shipped"] });
  assert.equal(opened.byId.get("shipped")!.collapsed, false);
  assert.equal(opened.byId.get("s1")!.hidden, false);
});

test("leaves are spaced evenly and a parent sits centred over its children", () => {
  const model = buildSwarmModel(
    [
      node("root", null, "plan", "working"),
      node("a", "root", "leaf", "open"),
      node("b", "root", "leaf", "open"),
      node("c", "root", "leaf", "open"),
    ],
    { now: 0 },
  );
  assert.deepEqual(
    ["a", "b", "c"].map((id) => model.byId.get(id)!.x),
    [0, COLUMN_PITCH, COLUMN_PITCH * 2],
  );
  // Midway between the first and last child, to the pixel.
  assert.equal(model.byId.get("root")!.x, COLUMN_PITCH);
  assert.equal(model.byId.get("root")!.y, 0);
  assert.equal(model.byId.get("a")!.y, ROW_PITCH);
  assert.equal(model.width, COLUMN_PITCH * 3 - (COLUMN_PITCH - NODE_WIDTH));
  assert.equal(model.height, ROW_PITCH * 2 - (ROW_PITCH - NODE_HEIGHT));
});

test("a collapsed subtree takes one leaf's worth of room, because that is what it is drawn as", () => {
  const model = buildSwarmModel(
    [
      node("root", null, "plan", "working"),
      node("shipped", "root", "plan", "done"),
      node("s1", "shipped", "leaf", "done"),
      node("s2", "shipped", "leaf", "done"),
      node("s3", "shipped", "leaf", "done"),
      node("live", "root", "leaf", "working"),
    ],
    { now: 0 },
  );
  assert.equal(model.byId.get("shipped")!.x, 0);
  assert.equal(model.byId.get("live")!.x, COLUMN_PITCH);
  assert.equal(model.width, COLUMN_PITCH + NODE_WIDTH);
});

test("an edge leaves the parent's bottom centre and arrives at the child's top centre", () => {
  const model = buildSwarmModel(
    [node("root", null, "plan", "working"), node("a", "root", "leaf", "open")],
    { now: 0 },
  );
  assert.equal(model.edges.length, 1);
  const edge = model.edges[0]!;
  assert.equal(edge.parentId, "root");
  assert.equal(edge.childId, "a");
  const centre = NODE_WIDTH / 2;
  assert.equal(
    edge.path,
    `M ${centre} ${NODE_HEIGHT} C ${centre} ${NODE_HEIGHT + 28}, ${centre} ${ROW_PITCH - 28}, ${centre} ${ROW_PITCH}`,
  );
});

test("an empty swarm is a model with nothing in it, not a crash", () => {
  const model = buildSwarmModel([], { now: 0 });
  assert.deepEqual(model.nodes, []);
  assert.deepEqual(model.edges, []);
  assert.equal(model.width, 0);
  assert.equal(model.height, 0);
  assert.equal(model.root.completion, 0);
  assert.equal(model.root.totalLeaves, 0);
  assert.deepEqual(outlineRows(model), []);
});

test("a single node swarm is its own root, and its ring is its own status", () => {
  const open = buildSwarmModel([node("only", null, "leaf", "open")], { now: 0 });
  assert.equal(open.nodes.length, 1);
  assert.equal(open.root.completion, 0);
  assert.equal(open.width, NODE_WIDTH);
  assert.equal(open.height, NODE_HEIGHT);
  assert.equal(open.byId.get("only")!.x, 0);
  assert.equal(open.byId.get("only")!.y, 0);

  const done = buildSwarmModel([node("only", null, "leaf", "done")], { now: 0 });
  assert.equal(done.root.completion, 1);
  // A root leaf has nothing to fold, so it is never drawn as folded.
  assert.equal(done.byId.get("only")!.collapsed, false);
});

test("two hundred nodes lay out once, stay stable, and hold a frame", () => {
  const tasks: SwarmTask[] = [];
  for (let i = 0; i < 200; i += 1) {
    const parent = i === 0 ? null : `n${Math.floor((i - 1) / 4)}`;
    const isPlan = i * 4 + 1 < 200;
    tasks.push(
      node(`n${i}`, parent, isPlan ? "plan" : "leaf", i % 3 === 0 ? "done" : "working", {
        position: i,
        weight: (i % 5) + 1,
        cost: spend(i / 100),
      }),
    );
  }

  const started = Date.now();
  const first = buildSwarmModel(tasks, { now: 0 });
  const elapsed = Date.now() - started;
  assert.equal(first.nodes.length, 200);
  // A landing may not spend a frame in here. Generous against a slow
  // machine, and still an order of magnitude under the 100ms budget.
  assert.ok(elapsed < 100, `layout took ${elapsed}ms`);

  // Same input, same output: nothing in here reads a clock or a
  // random, so a re-render cannot shuffle the tree.
  const second = buildSwarmModel(tasks, { now: 0 });
  assert.deepEqual(
    second.nodes.map((n) => [n.id, n.x, n.y, n.completion]),
    first.nodes.map((n) => [n.id, n.x, n.y, n.completion]),
  );
  assert.equal(second.edges.length, first.edges.length);

  // And through the cache it is literally computed once: the strip's
  // ring, the header, the tree and the outline share one build.
  const cached = createModelCache();
  const once = cached(tasks, { now: 0 });
  assert.equal(cached(tasks, { now: 0 }), once);
  // A changed input is a new build rather than a stale answer.
  assert.notEqual(cached(tasks, { now: 1 }), once);
});

test("a cycle in the tree draws what arrived instead of hanging", () => {
  const model = buildSwarmModel(
    [
      node("a", "b", "plan", "working", { position: 0 }),
      node("b", "a", "plan", "working", { position: 1 }),
      node("c", null, "leaf", "done", { position: 2 }),
    ],
    { now: 0 },
  );
  assert.deepEqual(model.nodes.map((n) => n.id), ["c"]);
  assert.equal(model.root.completion, 1);
});

test("a task whose parent never arrived is drawn as a root", () => {
  const model = buildSwarmModel(
    [node("orphan", "missing", "leaf", "working", { position: 0 })],
    { now: 0 },
  );
  assert.deepEqual(model.orphanIds, ["orphan"]);
  assert.equal(model.byId.get("orphan")!.depth, 0);
  assert.equal(model.nodes.length, 1);
});

test("a working leaf turns yellow once it passes the long run line", () => {
  const start = new Date(1_000_000).toISOString();
  const inside = buildSwarmModel(
    [node("a", null, "leaf", "working", { startedAt: start })],
    { now: 1_000_000 + LONG_RUN_WARNING_MS - 1 },
  );
  assert.equal(inside.byId.get("a")!.attention, "none");

  const past = buildSwarmModel(
    [node("a", null, "leaf", "working", { startedAt: start })],
    { now: 1_000_000 + LONG_RUN_WARNING_MS },
  );
  assert.equal(past.byId.get("a")!.attention, "long_running");
  assert.equal(past.byId.get("a")!.status, "working");
  assert.equal(past.byId.get("a")!.elapsedMs, LONG_RUN_WARNING_MS);
});

test("the ring is the same arc at every size, and never more than full", () => {
  const small = ringGeometry(0.5, 16, 2.5);
  assert.equal(small.radius, 6.75);
  assert.ok(Math.abs(small.circumference - 2 * Math.PI * 6.75) < 1e-9);
  assert.ok(Math.abs(small.dash - small.circumference / 2) < 1e-9);
  assert.ok(Math.abs(small.gap - small.circumference / 2) < 1e-9);

  const header = ringGeometry(0.5, 44, 4);
  assert.ok(Math.abs(header.dash / header.circumference - small.dash / small.circumference) < 1e-9);

  assert.equal(ringGeometry(2, 16, 2).dash, ringGeometry(1, 16, 2).circumference);
  assert.equal(ringGeometry(-1, 16, 2).dash, 0);
  assert.equal(ringGeometry(Number.NaN, 16, 2).dash, 0);
});

test("a percentage never rounds up to finished", () => {
  assert.equal(formatCompletion(0), "0%");
  assert.equal(formatCompletion(0.6), "60%");
  assert.equal(formatCompletion(0.999), "99%");
  assert.equal(formatCompletion(1), "100%");
  assert.equal(formatCompletion(2), "100%");
});
