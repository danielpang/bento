import type { LeafReview, NodeType, SpendTier, SwarmSpend, SwarmTask, TaskAttention, TaskStatus } from "./types.js";

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
export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 108;
/** Between two neighbouring leaves, and between two rows. */
export const COLUMN_GAP = 32;
export const ROW_GAP = 64;

/** Horizontal distance between one leaf's left edge and the next. */
export const COLUMN_PITCH = NODE_WIDTH + COLUMN_GAP;
/** Vertical distance between one depth and the next. */
export const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/**
 * Inside a branch's column, how far a child steps right of its parent.
 * Each level of the subtree is one more step, the way a file tree
 * indents, so depth reads from the left edge and siblings line up.
 */
export const INDENT = 24;
/** Between two cards stacked one above the other in a column. */
export const STACK_GAP = 20;
/** Where a parent's rail runs down, measured from its left edge. */
export const RAIL_OFFSET = 12;
/** Where a rail turns into a child, measured down from the child's top. */
export const RAIL_ENTRY = 26;

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

/**
 * A follow up, as a node inside one reads it.
 *
 * `rootId` is the node the reopen made, so a view can tell the head of
 * a follow up from the work underneath it and label one without
 * repeating itself on every descendant. `instruction` is what the
 * person asked for, in their own words, so it renders as text.
 */
export interface FollowUp {
  rootId: string;
  instruction: string;
}

export interface SwarmNode {
  id: string;
  parentId: string | null;
  parentRelation: "contains" | "depends_on";
  childIds: string[];
  depth: number;
  title: string;
  nodeType: NodeType;
  status: TaskStatus;
  /**
   * An agent is running in a sandbox for this node.
   *
   * A plan that only inherited working from its children is not this,
   * and neither is a run that is still queued or starting.
   */
  agentActive: boolean;
  /**
   * Where a finished leaf's work is: reported and waiting for the
   * planner's review, accepted and waiting to land, or failed to land.
   * Null for anything else. Without it a leaf whose agent had finished
   * read as "pending", as if its agent had not started.
   */
  landing: NodeLanding;
  /** Where a "review" landing stands with the planner. Null for any other landing. */
  review: LeafReview | null;
  /** Derived, not copied: see `attentionFor`. */
  attention: TaskAttention;
  weight: number;
  /** This node's own charges, by tier, as its row carries them. */
  ownCost: SwarmSpend;
  /** Own plus the whole subtree's, rolled up here rather than by the server. */
  cost: SwarmSpend;
  /** Weighted share of this subtree's leaves that are done, 0 to 1. */
  completion: number;
  doneWeight: number;
  totalWeight: number;
  doneLeaves: number;
  totalLeaves: number;
  /** Milliseconds this node has been working, or worked for. */
  elapsedMs: number;
  /**
   * Milliseconds the agent has been in the sandbox, or null when
   * that clock is not known. The long-run note uses this, because
   * elapsedMs starts when the task was handed a run.
   */
  runningForMs: number | null;
  /** A worker is on this node, or it is asking for a person. */
  frontier: boolean;
  /** This node, or something under it, is on the frontier. */
  frontierPath: boolean;
  /**
   * The follow up this node belongs to, or null for the first pass.
   *
   * Set on the node a reopen made and carried down its whole subtree,
   * which is the only reason it is computed here: the row carries the
   * instruction on one node, and what both views want to say is that
   * everything under it is work that follow up asked for.
   */
  followUp: FollowUp | null;
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
  relation: "contains" | "depends_on";
  /**
   * The drawn line. Into a column's head it runs from the parent's
   * bottom centre, across, and down to the child's top centre. Inside
   * a column it is one stretch of the parent's rail, from the sibling
   * above (or the parent) down to this child, then right into it.
   */
  path: string;
  /**
   * Leads to work that is happening. A rail stretch is shared by every
   * sibling below it, so it is lit when any of them is on the frontier,
   * not only the child it ends at.
   */
  live: boolean;
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
  /** Nodes a person folded by hand, even while work below them is active. */
  folded?: Iterable<string>;
  /** Finished swarms keep their full tree visible unless a person folds it. */
  autoCollapseCompleted?: boolean;
  /** The instant the model is for. Passed, never read from the clock. */
  now?: number;
  /** How long a working leaf may run before it turns yellow. */
  longRunMs?: number;
  /**
   * Tasks whose agent is running in a sandbox right now.
   *
   * When this is set, it is the only thing that makes a node active:
   * a status of working with a run id can still be queued or starting,
   * and those are pending until the agent is actually in the sandbox.
   * Omitted, the model falls back to a working row that already names
   * a run, which is what the tests that build a tree by hand use.
   */
  runningTaskIds?: ReadonlySet<string>;
  /**
   * When the agent on a task was started, keyed by task id.
   *
   * The long-run clock. Only consulted together with runningTaskIds:
   * a fixture that omits both keeps timing from the task row.
   */
  agentStartedAt?: ReadonlyMap<string, string>;
}

const NO_SPEND: SwarmSpend = { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0 };

export function addSpend(a: SwarmSpend, b: SwarmSpend): SwarmSpend {
  return {
    measuredUsd: a.measuredUsd + b.measuredUsd,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    assumedUsd: a.assumedUsd + b.assumedUsd,
    notionalUsd: a.notionalUsd + b.notionalUsd,
  };
}

/**
 * Whether this node wants a person, which the server may already have
 * decided. A leaf past the long run line turns yellow here even when
 * the server has not caught up, and an escalation is never downgraded
 * by the clock.
 */
export function attentionFor(
  task: SwarmTask,
  now: number,
  longRunMs = LONG_RUN_WARNING_MS,
  /**
   * Whether an agent is in the sandbox, and when it started.
   *
   * Omitted, the clock falls back to a working or assigned leaf and
   * the task's own start, which is what a fixture that builds a tree
   * by hand can know. Passed, including with active false, that
   * fallback is off: a wait for a sandbox is not a long run, and a
   * "still running" flag is dropped until an agent is actually
   * running. The start is the agent's, not the task's.
   */
  agent?: { active: boolean; startedAt: string | null },
): TaskAttention {
  // "Still running" is a claim about an agent that is running now.
  // A flag left from a wait, or from a run that has not reached the
  // sandbox, is not that. Escalated is a notice that already went
  // out, so it stays until the server takes it back.
  if (task.attention === "long_running") {
    const active = agent ? agent.active : task.nodeType === "leaf" && WORKING.includes(task.status);
    return active ? "long_running" : "none";
  }
  if (task.attention !== "none") return task.attention;
  if (agent) {
    if (!agent.active || task.nodeType !== "leaf" || !agent.startedAt) return "none";
    return elapsedFor({ startedAt: agent.startedAt, endedAt: null }, now) >= longRunMs ? "long_running" : "none";
  }
  if (task.nodeType !== "leaf" || !WORKING.includes(task.status)) return "none";
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
 * Depth first through the tree. The plan fans out sideways only where
 * it first branches: each branch there is a column, and everything
 * under a branch stacks down its column, indented a step per level.
 * Fanning every level sideways put each leaf in a column of its own,
 * so a plan of five branches and fifteen leaves was fifteen cards
 * wide and a branch's work was spread across the screen. A collapsed
 * node is one card, because that is what it is drawn as.
 */
export function buildSwarmModel(tasks: SwarmTask[], options: ModelOptions = {}): SwarmModel {
  const now = options.now ?? 0;
  const longRunMs = options.longRunMs ?? LONG_RUN_WARNING_MS;
  const expanded = new Set(options.expanded ?? []);
  const folded = new Set(options.folded ?? []);

  const byId = new Map<string, SwarmNode>();
  const childIds = new Map<string, string[]>();
  const orphanIds: string[] = [];

  for (const task of tasks) {
    // An empty set is an answer: nobody is in a sandbox. Omitting the
    // set is the fixture path, which treats a working row that names
    // a run as active.
    const runningTaskIds = options.runningTaskIds;
    const live = runningTaskIds !== undefined;
    const agentActive = runningTaskIds
      ? runningTaskIds.has(task.id)
      : task.status === "working" && task.assignedRunId !== null;
    const agentStartedAt = live ? options.agentStartedAt?.get(task.id) ?? null : null;
    byId.set(task.id, {
      id: task.id,
      parentId: task.parentId,
      parentRelation: task.parentRelation ?? "contains",
      childIds: [],
      depth: 0,
      title: task.title,
      nodeType: task.nodeType,
      status: task.status,
      agentActive,
      landing: nodeLanding(task),
      review: nodeReview(task),
      attention: attentionFor(task, now, longRunMs, live ? { active: agentActive, startedAt: agentStartedAt } : undefined),
      weight: Number.isFinite(task.weight) && task.weight > 0 ? task.weight : 1,
      ownCost: task.cost,
      cost: task.cost,
      completion: 0,
      doneWeight: 0,
      totalWeight: 0,
      doneLeaves: 0,
      totalLeaves: 0,
      elapsedMs: elapsedFor(task, now),
      runningForMs: agentStartedAt ? elapsedFor({ startedAt: agentStartedAt, endedAt: null }, now) : null,
      frontier: false,
      frontierPath: false,
      // Filled in on the walk below, because it is inherited from an
      // ancestor rather than read off the row.
      followUp: task.followUpInstruction
        ? { rootId: task.id, instruction: task.followUpInstruction }
        : null,
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

  function walk(id: string, depth: number, followUp: FollowUp | null): void {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (!node) return;
    seen.add(id);
    node.depth = depth;
    /*
     * A node's own instruction wins over the one it inherited, so a
     * swarm reopened twice under the same branch of the tree reads as
     * the nearer follow up rather than the first one. Otherwise the
     * ancestor's travels down.
     */
    node.followUp = node.followUp ?? followUp;
    nodes.push(node);
    for (const childId of node.childIds) walk(childId, depth + 1, node.followUp);
  }
  for (const id of roots) walk(id, 0, null);

  // Deepest first, so a parent reads figures its children have finished.
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    const kids = node.childIds.map((id) => byId.get(id)).filter((n): n is SwarmNode => !!n && seen.has(n.id));
    node.frontier = WORKING.includes(node.status) || node.attention !== "none";
    if (kids.length === 0) {
      const counted = !isAbandoned(node.status) && node.nodeType === "leaf";
      node.totalWeight = counted ? node.weight : 0;
      node.doneWeight = counted && isDone(node.status) ? node.weight : 0;
      node.totalLeaves = counted ? 1 : 0;
      node.doneLeaves = counted && isDone(node.status) ? 1 : 0;
      node.cost = node.ownCost;
      node.frontierPath = node.frontier;
    } else {
      /*
       * A node's own charges, plus everything under it.
       *
       * The reader owns this rollup, and the row owns only itself: a
       * task's three figures are what was charged to that one task,
       * which is what makes adding the children here count every
       * charge exactly once. The server's tick agrees (it rewrites a
       * group's status and leaves its cost columns alone); while it
       * wrote the subtree total onto the group row as well, this loop
       * added the children in on top of it and every plan node read
       * double.
       */
      let cost = node.ownCost;
      // A leaf may be a prerequisite for children and still be work of
      // its own. Count it as well as its descendants in the rollup.
      const ownLeaf = node.nodeType === "leaf" && !isAbandoned(node.status);
      let doneWeight = ownLeaf && isDone(node.status) ? node.weight : 0;
      let totalWeight = ownLeaf ? node.weight : 0;
      let doneLeaves = ownLeaf && isDone(node.status) ? 1 : 0;
      let totalLeaves = ownLeaf ? 1 : 0;
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
   * A subtree with nothing left to do folds into one filled node. A
   * person may also fold a live subtree. Opening a node by hand keeps
   * it open, and everything under a folded node is hidden rather than
   * removed: the outline still lists it, and the same model answers
   * both views.
   */
  for (const node of nodes) {
    // Folded away by an ancestor already: nothing under it to decide.
    if (node.hidden) continue;
    const complete =
      options.autoCollapseCompleted !== false &&
      node.childIds.length > 0 &&
      node.totalLeaves > 0 &&
      node.doneLeaves === node.totalLeaves &&
      !node.frontierPath &&
      !expanded.has(node.id);
    if (node.childIds.length > 0 && (folded.has(node.id) || complete)) {
      node.collapsed = true;
      hideSubtree(node, byId);
    }
  }

  /*
   * Position.
   *
   * The spine is the run of single nodes from the top before the plan
   * first branches: one root, and its only child, and so on. Each sits
   * on a row of its own, centred over what is below. Where it branches
   * (or at the roots, when there are several) each branch becomes a
   * column, side by side, and a column lists its subtree depth first,
   * one card under the next, each a step further right than its parent.
   */
  const shown = (node: SwarmNode): SwarmNode[] =>
    node.collapsed
      ? []
      : node.childIds.map((id) => byId.get(id)).filter((n): n is SwarmNode => !!n && !n.hidden && seen.has(n.id));
  const spine: SwarmNode[] = [];
  let heads = nodes.filter((node) => node.depth === 0 && !node.hidden);
  while (heads.length === 1) {
    spine.push(heads[0]!);
    heads = shown(heads[0]!);
  }
  const inSpine = new Set(spine.map((node) => node.id));

  const top = spine.length * ROW_PITCH;
  let cursor = 0;
  let bottom = spine.length > 0 ? top - ROW_GAP : 0;
  for (const head of heads) {
    let y = top;
    let right = cursor + NODE_WIDTH;
    const stack = (node: SwarmNode, level: number): void => {
      node.x = cursor + level * INDENT;
      node.y = y;
      right = Math.max(right, node.x + NODE_WIDTH);
      y += NODE_HEIGHT + STACK_GAP;
      for (const kid of shown(node)) stack(kid, level + 1);
    };
    stack(head, 0);
    bottom = Math.max(bottom, y - STACK_GAP);
    cursor = right + COLUMN_GAP;
  }
  const spineX = heads.length > 0 ? (heads[0]!.x + heads[heads.length - 1]!.x) / 2 : 0;
  spine.forEach((node, row) => {
    node.x = spineX;
    node.y = row * ROW_PITCH;
  });
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
    const kids = shown(node);
    kids.forEach((child, index) => {
      edges.push({
        id: `${node.id}:${child.id}`,
        parentId: node.id,
        childId: child.id,
        relation: child.parentRelation,
        path: inSpine.has(node.id)
          ? edgePath(node, child)
          : railPath(node, child, index > 0 ? kids[index - 1]! : null),
        live: inSpine.has(node.id)
          ? child.frontierPath
          : kids.slice(index).some((kid) => kid.frontierPath),
      });
    });
  }
  // Lit lines last, so where two lines share a stretch the one leading
  // to work in progress is the one on top.
  edges.sort((a, b) => Number(a.live) - Number(b.live));

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
    width: heads.length > 0 ? cursor - COLUMN_GAP : spine.length > 0 ? NODE_WIDTH : 0,
    height: bottom,
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
 * The line from a card above to a card on the row below.
 *
 * Down from the parent's bottom centre to halfway, across, and down
 * into the child's top centre, with rounded corners. Every child of
 * one parent shares the crossbar, so a fan of columns reads as one
 * bus rather than a spray of curves, which cross-hatch once there are
 * more than a handful.
 */
export function edgePath(parent: Pick<SwarmNode, "x" | "y">, child: Pick<SwarmNode, "x" | "y">): string {
  return busPath(parent.x + NODE_WIDTH / 2, parent.y + NODE_HEIGHT, child.x + NODE_WIDTH / 2, child.y);
}

/** The bus line between two points, the lower one below the upper. */
export function busPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  if (Math.abs(dx) < 1) return `M ${round(x1)} ${round(y1)} V ${round(y2)}`;
  const mid = y1 + (y2 - y1) / 2;
  const r = Math.min(8, Math.abs(dx) / 2, (y2 - y1) / 4);
  const s = Math.sign(dx);
  return [
    `M ${round(x1)} ${round(y1)}`,
    `V ${round(mid - r)}`,
    `Q ${round(x1)} ${round(mid)}, ${round(x1 + s * r)} ${round(mid)}`,
    `H ${round(x2 - s * r)}`,
    `Q ${round(x2)} ${round(mid)}, ${round(x2)} ${round(mid + r)}`,
    `V ${round(y2)}`,
  ].join(" ");
}

/**
 * One stretch of a parent's rail inside a column.
 *
 * The rail runs down the parent's left side, under its card. Each
 * child's stretch starts where the sibling above it turned off (or at
 * the parent's bottom, for the first), so no two stretches overlap and
 * each can be dashed or lit on its own, then turns right into the
 * child's left edge.
 */
export function railPath(
  parent: Pick<SwarmNode, "x" | "y">,
  child: Pick<SwarmNode, "x" | "y">,
  above: Pick<SwarmNode, "y"> | null,
): string {
  const x = parent.x + RAIL_OFFSET;
  const y1 = above ? above.y + RAIL_ENTRY : parent.y + NODE_HEIGHT;
  const y2 = child.y + RAIL_ENTRY;
  const r = Math.min(6, (child.x - x) / 2, (y2 - y1) / 2);
  return [
    `M ${round(x)} ${round(y1)}`,
    `V ${round(y2 - r)}`,
    `Q ${round(x)} ${round(y2)}, ${round(x + r)} ${round(y2)}`,
    `H ${round(child.x)}`,
  ].join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export type NodeLanding = "waiting" | "failed" | "review" | null;

/**
 * Where a leaf's finished work is, when its row's status does not say.
 *
 * "failed" when its landing failed, "waiting" once the planner
 * accepted it and its branch is in the merge queue, and "review" when
 * its worker reported and the planner has not accepted it yet. A
 * failed leaf is never "waiting": an acceptance left on a leaf whose
 * next attempt failed is about the attempt before, and read as waiting
 * to land it hid the failure.
 */
export function nodeLanding(task: {
  nodeType: NodeType;
  status: TaskStatus;
  report?: string | null;
  flags?: Record<string, unknown> | null;
}): NodeLanding {
  if (task.nodeType !== "leaf" || (task.status !== "working" && task.status !== "landed" && task.status !== "failed")) return null;
  if (typeof task.flags?.landingError === "string") return "failed";
  if (task.status === "failed") return null;
  if (task.status === "landed" || task.flags?.accepted === true) return "waiting";
  if (typeof task.report === "string" && task.report.trim() !== "") return "review";
  return null;
}

/**
 * Where a leaf waiting for review stands with the planner. Read only
 * under a "review" landing, so a review the server sent before an
 * optimistic accept or retry cannot outlive it.
 */
export function nodeReview(task: Parameters<typeof nodeLanding>[0] & { review?: LeafReview | null }): LeafReview | null {
  return nodeLanding(task) === "review" ? task.review ?? "waiting" : null;
}

/** One row of the outline: the same node, read as a list rather than a tree. */
export interface OutlineRow {
  id: string;
  depth: number;
  title: string;
  parentRelation: "contains" | "depends_on";
  nodeType: NodeType;
  status: TaskStatus;
  agentActive: boolean;
  landing: NodeLanding;
  review: LeafReview | null;
  attention: TaskAttention;
  completion: number;
  cost: SwarmSpend;
  /** True when the figures are a subtree's, not this node's own. */
  rolled: boolean;
  hasChildren: boolean;
  elapsedMs: number;
  /** Agent time, when the agent start is known. The long-run note uses it. */
  runningForMs: number | null;
  doneLeaves: number;
  totalLeaves: number;
  /** The follow up this row is inside, or null for the first pass. */
  followUp: FollowUp | null;
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
    parentRelation: node.parentRelation,
    nodeType: node.nodeType,
    status: node.status,
    agentActive: node.agentActive,
    landing: node.landing,
    review: node.review,
    attention: node.attention,
    completion: node.completion,
    cost: node.cost,
    rolled: node.childIds.length > 0,
    hasChildren: node.childIds.length > 0,
    elapsedMs: node.elapsedMs,
    runningForMs: node.runningForMs,
    doneLeaves: node.doneLeaves,
    totalLeaves: node.totalLeaves,
    followUp: node.followUp,
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
    // "fallback" and "set:" are different answers. An empty set means
    // nobody is in a sandbox; omitting the set means a working row
    // that names a run is active. Collapsing both to an empty string
    // handed the second call the first model.
    const running = options.runningTaskIds !== undefined
      ? `set:${[...options.runningTaskIds].sort().join(",")}`
      : "fallback";
    const started = [...(options.agentStartedAt?.entries() ?? [])]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, at]) => `${id}=${at}`)
      .join(",");
    const key = `${[...(options.expanded ?? [])].sort().join(",")}|${[...(options.folded ?? [])].sort().join(",")}|${options.autoCollapseCompleted !== false}|${options.now ?? 0}|${options.longRunMs ?? LONG_RUN_WARNING_MS}|${running}|${started}`;
    if (last && lastTasks === tasks && lastKey === key) return last;
    last = buildSwarmModel(tasks, options);
    lastTasks = tasks;
    lastKey = key;
    return last;
  };
}

/** Every tier, in the order they are always printed. */
/**
 * Every tier, in the order they are always printed: most trustworthy
 * first, and the one the budget does not count last.
 */
export const SPEND_TIERS: SpendTier[] = ["measured", "estimated", "notional"];
