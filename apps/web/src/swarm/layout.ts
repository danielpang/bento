import type { SpendTier, SwarmSpend, SwarmTask, TaskAttention, TaskKind, TaskStatus } from "./types.js";

/**
 * The plan, as numbers.
 *
 * One module builds the whole model: the rollup, the collapse rule,
 * every node's position, and the edge between each parent and child.
 * Tree and Outline both render from what comes back, which is the
 * only reason the two can never disagree about a completion, a cost,
 * or which nodes are folded away. It is plain data in and plain data
 * out, so the arithmetic is testable without a browser.
 *
 * Nothing here reads the clock on its own: `now` is passed in, so the
 * same tasks and the same instant always produce the same model.
 */

/** A node card, in pixels. Roughly a title, a ring, a status, a cost. */
export const NODE_WIDTH = 124;
export const NODE_HEIGHT = 80;
/** Between two neighbouring leaves, and between two rows. */
export const COLUMN_GAP = 24;
export const ROW_GAP = 56;

/** Horizontal distance between one leaf's left edge and the next. */
export const COLUMN_PITCH = NODE_WIDTH + COLUMN_GAP;
/** Vertical distance between one depth and the next. */
export const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/**
 * How long a leaf may work before the console says so, in
 * milliseconds. The server raises `long_running` itself when it
 * notices; this is the same line drawn in the browser, so a leaf that
 * passes it between two polls still turns yellow.
 */
export const LONG_RUN_WARNING_MS = 20 * 60 * 1000;

/** Statuses that mean a worker is on this leaf right now. */
const WORKING: TaskStatus[] = ["assigned", "working"];

/** Complete for the rollup. Only `done` counts; `landed` is not finished. */
function isDone(status: TaskStatus): boolean {
  return status === "done";
}

/**
 * A leaf that is no longer work.
 *
 * Cancelled leaves leave the rollup entirely rather than counting as
 * unfinished. Kept in the denominator, a swarm that cancelled a
 * branch could never reach 100%, and the ring at the root would sit
 * short of full over a tree with nothing left to do in it.
 */
function isAbandoned(status: TaskStatus): boolean {
  return status === "cancelled";
}

export interface SwarmNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  depth: number;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  /** Derived, not copied: see `attentionFor`. */
  attention: TaskAttention;
  weight: number;
  /** This node's own charges, by tier. A plan node's is its planner. */
  ownCost: SwarmSpend;
  /** Rolled up through the subtree for a plan, the same as own for a leaf. */
  cost: SwarmSpend;
  /** Weighted share of this subtree's leaves that are done, 0 to 1. */
  completion: number;
  doneWeight: number;
  totalWeight: number;
  doneLeaves: number;
  totalLeaves: number;
  /** Milliseconds this node has been working, or worked for. */
  elapsedMs: number;
  /** A worker is on this node, or it is asking for a person. */
  frontier: boolean;
  /** This node, or something under it, is on the frontier. */
  frontierPath: boolean;
  /** Drawn as one filled node, with its subtree folded into it. */
  collapsed: boolean;
  /** Inside somebody else's collapsed subtree. Never drawn in the tree. */
  hidden: boolean;
  /** Left edge and top edge of the card, in layout pixels. */
  x: number;
  y: number;
}

export interface SwarmEdge {
  id: string;
  parentId: string;
  childId: string;
  /** A cubic bezier from the parent's bottom centre to the child's top. */
  path: string;
}

export interface SwarmRollup {
  completion: number;
  doneWeight: number;
  totalWeight: number;
  doneLeaves: number;
  totalLeaves: number;
  cost: SwarmSpend;
}

export interface SwarmModel {
  /** Every task, in tree order (depth first, siblings by position). */
  nodes: SwarmNode[];
  byId: Map<string, SwarmNode>;
  /** Only between nodes the tree actually draws. */
  edges: SwarmEdge[];
  /** The swarm itself: the root nobody stores. The headline number. */
  root: SwarmRollup;
  width: number;
  height: number;
  /** Tasks naming a parent that is not in the list, treated as roots. */
  orphanIds: string[];
}

export interface ModelOptions {
  /** Nodes a person opened by hand, which stay open however done they are. */
  expanded?: Iterable<string>;
  /** The instant the model is for. Passed, never read from the clock. */
  now?: number;
  /** How long a working leaf may run before it turns yellow. */
  longRunMs?: number;
}

const NO_SPEND: SwarmSpend = { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 };

export function addSpend(a: SwarmSpend, b: SwarmSpend): SwarmSpend {
  return {
    measuredUsd: a.measuredUsd + b.measuredUsd,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    assumedUsd: a.assumedUsd + b.assumedUsd,
  };
}

/**
 * Whether this node wants a person, which the server may already have
 * decided. A leaf past the long run line turns yellow here even when
 * the server has not caught up, and an escalation is never downgraded
 * by the clock.
 */
export function attentionFor(task: SwarmTask, now: number, longRunMs = LONG_RUN_WARNING_MS): TaskAttention {
  if (task.attention !== "none") return task.attention;
  if (task.kind !== "leaf" || !WORKING.includes(task.status)) return "none";
  return elapsedFor(task, now) >= longRunMs ? "long_running" : "none";
}

/** How long this task has been going, or went on for once it stopped. */
export function elapsedFor(task: Pick<SwarmTask, "startedAt" | "endedAt">, now: number): number {
  if (!task.startedAt) return 0;
  const started = new Date(task.startedAt).getTime();
  if (!Number.isFinite(started)) return 0;
  const ended = task.endedAt ? new Date(task.endedAt).getTime() : now;
  return Math.max(0, (Number.isFinite(ended) ? ended : now) - started);
}

/**
 * The whole model, from the task rows.
 *
 * Depth first through the tree. Leaves are spaced evenly, a parent
 * sits centred over its own children, and a collapsed node takes one
 * leaf's worth of room because that is what it is drawn as.
 */
export function buildSwarmModel(tasks: SwarmTask[], options: ModelOptions = {}): SwarmModel {
  const now = options.now ?? 0;
  const longRunMs = options.longRunMs ?? LONG_RUN_WARNING_MS;
  const expanded = new Set(options.expanded ?? []);

  const byId = new Map<string, SwarmNode>();
  const childIds = new Map<string, string[]>();
  const orphanIds: string[] = [];

  for (const task of tasks) {
    byId.set(task.id, {
      id: task.id,
      parentId: task.parentId,
      childIds: [],
      depth: 0,
      title: task.title,
      kind: task.kind,
      status: task.status,
      attention: attentionFor(task, now, longRunMs),
      weight: Number.isFinite(task.weight) && task.weight > 0 ? task.weight : 1,
      ownCost: task.cost,
      cost: task.cost,
      completion: 0,
      doneWeight: 0,
      totalWeight: 0,
      doneLeaves: 0,
      totalLeaves: 0,
      elapsedMs: elapsedFor(task, now),
      frontier: false,
      frontierPath: false,
      collapsed: false,
      hidden: false,
      x: 0,
      y: 0,
    });
  }

  /*
   * A parent nobody sent is a root, not a lost node. The tree comes
   * from a planner agent, and a tree with a node missing from the
   * middle of it must still draw everything that did arrive.
   */
  const roots: string[] = [];
  for (const task of tasks) {
    const parentId = task.parentId;
    if (parentId === null) {
      roots.push(task.id);
      continue;
    }
    if (!byId.has(parentId)) {
      orphanIds.push(task.id);
      roots.push(task.id);
      const node = byId.get(task.id);
      if (node) node.parentId = null;
      continue;
    }
    const siblings = childIds.get(parentId);
    if (siblings) siblings.push(task.id);
    else childIds.set(parentId, [task.id]);
  }

  const position = new Map(tasks.map((task) => [task.id, task.position]));
  const order = (a: string, b: string) =>
    (position.get(a) ?? 0) - (position.get(b) ?? 0) || a.localeCompare(b);
  roots.sort(order);
  for (const [id, kids] of childIds) {
    kids.sort(order);
    const node = byId.get(id);
    if (node) node.childIds = kids;
  }

  /*
   * A cycle is possible: parentId comes from an agent, and two nodes
   * naming each other would walk forever. Visiting each id once turns
   * that into a node that simply does not draw.
   */
  const seen = new Set<string>();
  const nodes: SwarmNode[] = [];

  function walk(id: string, depth: number): void {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    node.depth = depth;
    nodes.push(node);
    for (const childId of node.childIds) walk(childId, depth + 1);
  }
  for (const id of roots) walk(id, 0);

  // Deepest first, so a parent reads figures its children have finished.
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    const kids = node.childIds.map((id) => byId.get(id)).filter((n): n is SwarmNode => !!n && seen.has(n.id));
    node.frontier = WORKING.includes(node.status) || node.attention !== "none";
    if (kids.length === 0) {
      const counted = !isAbandoned(node.status) && node.kind === "leaf";
      node.totalWeight = counted ? node.weight : 0;
      node.doneWeight = counted && isDone(node.status) ? node.weight : 0;
      node.totalLeaves = counted ? 1 : 0;
      node.doneLeaves = counted && isDone(node.status) ? 1 : 0;
      node.cost = node.ownCost;
      node.frontierPath = node.frontier;
    } else {
      let cost = node.ownCost;
      let doneWeight = 0;
      let totalWeight = 0;
      let doneLeaves = 0;
      let totalLeaves = 0;
      let frontierPath = node.frontier;
      for (const kid of kids) {
        cost = addSpend(cost, kid.cost);
        doneWeight += kid.doneWeight;
        totalWeight += kid.totalWeight;
        doneLeaves += kid.doneLeaves;
        totalLeaves += kid.totalLeaves;
        frontierPath = frontierPath || kid.frontierPath;
      }
      node.cost = cost;
      node.doneWeight = doneWeight;
      node.totalWeight = totalWeight;
      node.doneLeaves = doneLeaves;
      node.totalLeaves = totalLeaves;
      node.frontierPath = frontierPath;
    }
    node.completion = node.totalWeight > 0 ? node.doneWeight / node.totalWeight : 0;
  }

  /*
   * Collapse, from the top down.
   *
   * A subtree with nothing left to do folds into one filled node; the
   * frontier never does, because the frontier is the part somebody is
   * watching. Opening a node by hand keeps it open, and everything
   * under a folded node is hidden rather than removed: the outline
   * still lists it, and the same model answers both views.
   */
  for (const node of nodes) {
    // Folded away by an ancestor already: nothing under it to decide.
    if (node.hidden) continue;
    const foldable =
      node.childIds.length > 0 &&
      node.totalLeaves > 0 &&
      node.doneLeaves === node.totalLeaves &&
      !node.frontierPath &&
      !expanded.has(node.id);
    if (foldable) {
      node.collapsed = true;
      hideSubtree(node, byId);
    }
  }

  // Position: leaves in the order they are met, parents over their own.
  let cursor = 0;
  let maxDepth = 0;
  function place(node: SwarmNode): void {
    node.y = node.depth * ROW_PITCH;
    maxDepth = Math.max(maxDepth, node.depth);
    const kids = node.collapsed
      ? []
      : node.childIds.map((id) => byId.get(id)).filter((n): n is SwarmNode => !!n && !n.hidden);
    if (kids.length === 0) {
      node.x = cursor * COLUMN_PITCH;
      cursor += 1;
      return;
    }
    for (const kid of kids) place(kid);
    const first = kids[0]!;
    const last = kids[kids.length - 1]!;
    node.x = (first.x + last.x) / 2;
  }
  for (const node of nodes) {
    if (node.depth === 0 && !node.hidden) place(node);
  }
  // A hidden node keeps the folded ancestor's place, so nothing that
  // is measured while folded reports a position at the origin.
  for (const node of nodes) {
    if (!node.hidden) continue;
    const anchor = visibleAncestor(node, byId);
    if (anchor) {
      node.x = anchor.x;
      node.y = anchor.y;
    }
  }

  const edges: SwarmEdge[] = [];
  for (const node of nodes) {
    if (node.hidden || node.collapsed) continue;
    for (const childId of node.childIds) {
      const child = byId.get(childId);
      if (!child || child.hidden) continue;
      edges.push({
        id: `${node.id}:${child.id}`,
        parentId: node.id,
        childId: child.id,
        path: edgePath(node, child),
      });
    }
  }

  let rootCost = NO_SPEND;
  let doneWeight = 0;
  let totalWeight = 0;
  let doneLeaves = 0;
  let totalLeaves = 0;
  for (const node of nodes) {
    if (node.depth !== 0) continue;
    rootCost = addSpend(rootCost, node.cost);
    doneWeight += node.doneWeight;
    totalWeight += node.totalWeight;
    doneLeaves += node.doneLeaves;
    totalLeaves += node.totalLeaves;
  }

  return {
    nodes,
    byId,
    edges,
    root: {
      completion: totalWeight > 0 ? doneWeight / totalWeight : 0,
      doneWeight,
      totalWeight,
      doneLeaves,
      totalLeaves,
      cost: rootCost,
    },
    width: cursor > 0 ? cursor * COLUMN_PITCH - COLUMN_GAP : 0,
    height: nodes.length > 0 ? (maxDepth + 1) * ROW_PITCH - ROW_GAP : 0,
    orphanIds,
  };
}

function hideSubtree(node: SwarmNode, byId: Map<string, SwarmNode>): void {
  for (const childId of node.childIds) {
    const child = byId.get(childId);
    if (!child || child.hidden) continue;
    child.hidden = true;
    hideSubtree(child, byId);
  }
}

function visibleAncestor(node: SwarmNode, byId: Map<string, SwarmNode>): SwarmNode | null {
  let current = node.parentId ? byId.get(node.parentId) : null;
  while (current && current.hidden) current = current.parentId ? byId.get(current.parentId) : null;
  return current ?? null;
}

/**
 * The line between a parent and a child.
 *
 * A cubic with both handles pulled halfway down the gap, so it leaves
 * the parent going down and arrives at the child going down: a
 * straight diagonal between two rows of cards reads as a cross-hatch
 * once there are more than a handful of them.
 */
export function edgePath(parent: Pick<SwarmNode, "x" | "y">, child: Pick<SwarmNode, "x" | "y">): string {
  const x1 = parent.x + NODE_WIDTH / 2;
  const y1 = parent.y + NODE_HEIGHT;
  const x2 = child.x + NODE_WIDTH / 2;
  const y2 = child.y;
  const bend = (y2 - y1) / 2;
  return `M ${round(x1)} ${round(y1)} C ${round(x1)} ${round(y1 + bend)}, ${round(x2)} ${round(y2 - bend)}, ${round(x2)} ${round(y2)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One row of the outline: the same node, read as a list rather than a tree. */
export interface OutlineRow {
  id: string;
  depth: number;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  attention: TaskAttention;
  completion: number;
  cost: SwarmSpend;
  /** True when the figures are a subtree's, not this node's own. */
  rolled: boolean;
  hasChildren: boolean;
  elapsedMs: number;
  doneLeaves: number;
  totalLeaves: number;
}

/**
 * The outline, in tree order.
 *
 * Read straight off the model the tree drew, which is the whole
 * point: switching view cannot change a number, a status, or whether
 * something is yellow. Folded nodes are still listed, because a list
 * indents rather than hides.
 */
export function outlineRows(model: SwarmModel): OutlineRow[] {
  return model.nodes.map((node) => ({
    id: node.id,
    depth: node.depth,
    title: node.title,
    kind: node.kind,
    status: node.status,
    attention: node.attention,
    completion: node.completion,
    cost: node.cost,
    rolled: node.childIds.length > 0,
    hasChildren: node.childIds.length > 0,
    elapsedMs: node.elapsedMs,
    doneLeaves: node.doneLeaves,
    totalLeaves: node.totalLeaves,
  }));
}

/** Nodes the tree actually draws. */
export function visibleNodes(model: SwarmModel): SwarmNode[] {
  return model.nodes.filter((node) => !node.hidden);
}

export interface RingGeometry {
  size: number;
  stroke: number;
  radius: number;
  centre: number;
  circumference: number;
  /** The drawn arc, for stroke-dasharray. */
  dash: number;
  gap: number;
}

/**
 * A completion ring at any size.
 *
 * The same fraction at four heights of the tree: the swarm's tab, the
 * page header, every plan node, and inside every leaf. One function,
 * so the arc for 60% is the same arc everywhere and the tab cannot
 * round differently from the header.
 */
export function ringGeometry(fraction: number, size: number, stroke: number): RingGeometry {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * clampFraction(fraction);
  return {
    size,
    stroke,
    radius,
    centre: size / 2,
    circumference,
    dash,
    gap: circumference - dash,
  };
}

/** 0 to 1, whatever arrives. A ring cannot be more than full. */
export function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/** "60%", the way every ring's label prints it. Never rounds up to 100. */
export function formatCompletion(fraction: number): string {
  const clamped = clampFraction(fraction);
  const pct = clamped >= 1 ? 100 : Math.min(99, Math.floor(clamped * 100));
  return `${pct}%`;
}

/**
 * A cache over the model, keyed on the exact inputs.
 *
 * The tree is laid out once per change and read many times: by the
 * tree, by the outline, by the strip's ring, and by the header. Two
 * hundred nodes is the size this has to hold a frame at, so the
 * answer is kept rather than recomputed per consumer.
 */
export function createModelCache(): (tasks: SwarmTask[], options?: ModelOptions) => SwarmModel {
  let lastTasks: SwarmTask[] | null = null;
  let lastKey = "";
  let last: SwarmModel | null = null;
  return (tasks, options = {}) => {
    const key = `${[...(options.expanded ?? [])].sort().join(",")}|${options.now ?? 0}|${options.longRunMs ?? LONG_RUN_WARNING_MS}`;
    if (last && lastTasks === tasks && lastKey === key) return last;
    last = buildSwarmModel(tasks, options);
    lastTasks = tasks;
    lastKey = key;
    return last;
  };
}

/** Every tier, in the order they are always printed. */
export const SPEND_TIERS: SpendTier[] = ["measured", "estimated", "assumed"];
