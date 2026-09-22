import type { SwarmDetailResponse, SwarmRow, SwarmTaskRow } from "@bento/api-client";

/**
 * A swarm's plan, drawn for a terminal.
 *
 * The console draws the same tree with bezier edges and rings. A
 * terminal has neither, so what survives is the shape and the three
 * things a person is actually watching for: how far along each node
 * is, whether anybody needs to look at it, and what it has cost.
 *
 * Pure, and that is the point. Everything here takes rows and returns
 * strings, so what the terminal prints can be held by a test without a
 * server, a screen, or a clock. The command below does the printing.
 */

/** Box drawing, which every terminal Bento supports already uses. */
const BRANCH = "├─ ";
const LAST = "└─ ";
const TRUNK = "│  ";
const GAP = "   ";

/** One glyph per status, so a column of nodes reads down the page. */
const MARK: Record<SwarmTaskRow["status"], string> = {
  open: "·",
  assigned: "◦",
  working: "▸",
  landed: "◆",
  done: "✓",
  blocked: "!",
  failed: "✗",
  cancelled: "–",
};

/** What a node's status is called, in the words the console uses. */
const WORDS: Record<SwarmTaskRow["status"], string> = {
  open: "open",
  assigned: "ready",
  working: "working",
  landed: "landed",
  done: "done",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
};

/** What a node is waiting for a person about, when it is. */
const ATTENTION: Record<string, string> = {
  long_running: "running long",
  escalated: "needs you",
  question: "asking",
  failed: "failed",
  conflict: "conflict",
  budget: "out of budget",
  plan_limit: "out of agent hours",
};

/** What a swarm's status is called. Two differ from the column's value. */
export function swarmWords(swarm: Pick<SwarmRow, "status" | "pausedReason">): string {
  if (swarm.status === "cancelled") return "stopped";
  if (swarm.status === "blocked") return "waiting on you";
  if (swarm.status === "budget_exhausted") return "out of budget";
  if (swarm.status === "timed_out") return "out of time";
  if (swarm.status === "paused") {
    return swarm.pausedReason === "plan_limit" ? "paused, out of agent hours" : "paused";
  }
  return swarm.status;
}

/** A swarm's spend, counted the way the budget counts it. */
export function spentUsd(swarm: SwarmRow): number {
  return (
    Number(swarm.spentMeasuredUsd ?? 0) +
    Number(swarm.spentEstimatedUsd ?? 0) +
    Number(swarm.spentAssumedUsd ?? 0)
  );
}

/** One node's own charges, the same three tiers. */
export function taskUsd(task: SwarmTaskRow): number {
  return (
    Number(task.costMeasuredUsd ?? 0) + Number(task.costEstimatedUsd ?? 0) + Number(task.costAssumedUsd ?? 0)
  );
}

/** Dollars, as this product prints them. */
export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** How many leaves under a node are finished, out of how many there are. */
export interface Rollup {
  done: number;
  total: number;
  /** Own charges plus everything under it. */
  usd: number;
}

/**
 * The tree, as lines.
 *
 * Depth first in the plan's own order, a parent's rollup read from its
 * children, and a cancelled node counted in nothing: work somebody
 * withdrew is not work outstanding, and counting it would keep a
 * finished node from ever reading as finished.
 *
 * A follow up node is labelled with what it was reopened for. Once,
 * on the node the reopen made, for the reason the console prints it
 * once: the same sentence on every descendant is not a label.
 */
export function swarmTreeLines(detail: SwarmDetailResponse): string[] {
  const byParent = new Map<string | null, SwarmTaskRow[]>();
  for (const task of detail.tasks) {
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }

  const working = new Set(
    detail.activeRuns.filter((run) => run.swarmTaskId !== null).map((run) => run.swarmTaskId!),
  );

  const lines: string[] = [];
  const seen = new Set<string>();
  /*
   * The tree comes from an agent, so a node naming itself as its own
   * ancestor is possible. Visiting each id once turns that into a node
   * that simply is not drawn twice.
   */
  const walk = (parentId: string | null, prefix: string): void => {
    const siblings = byParent.get(parentId) ?? [];
    siblings.forEach((task, index) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      const last = index === siblings.length - 1;
      lines.push(`${prefix}${last ? LAST : BRANCH}${nodeLine(task, byParent, working)}`);
      const follow = task.followUpInstruction?.trim();
      if (follow) lines.push(`${prefix}${last ? GAP : TRUNK}   follow up: ${oneLine(follow)}`);
      walk(task.id, `${prefix}${last ? GAP : TRUNK}`);
    });
  };
  walk(null, "");
  return lines;
}

/** One node, on one line. */
function nodeLine(
  task: SwarmTaskRow,
  byParent: Map<string | null, SwarmTaskRow[]>,
  working: Set<string>,
): string {
  const rolled = rollUp(task, byParent);
  const parts = [`${MARK[task.status]} ${oneLine(task.title)}`];
  /*
   * A plan node reads as a count and a leaf as a state, whichever the
   * status column happens to say. A plan node's status is the rollup
   * of its children, so printing both would be the same fact twice;
   * and a plan node with no children yet still reads as a plan node
   * rather than as a task somebody could work, which is what "0/0"
   * says and "open" does not.
   */
  if (task.nodeType === "plan") {
    parts.push(`${rolled.done}/${rolled.total}`);
  } else {
    parts.push(working.has(task.id) ? "working" : WORDS[task.status]);
  }
  const attention = task.attention ? (ATTENTION[task.attention] ?? "needs you") : null;
  if (attention) parts.push(attention);
  if (rolled.usd > 0) parts.push(money(rolled.usd));
  return parts.join("  ");
}

/** A node's leaves and charges, its own and everything under it. */
export function rollUp(task: SwarmTaskRow, byParent: Map<string | null, SwarmTaskRow[]>): Rollup {
  const children = byParent.get(task.id) ?? [];
  if (children.length === 0) {
    const counted = task.nodeType === "leaf" && task.status !== "cancelled";
    return {
      done: counted && task.status === "done" ? 1 : 0,
      total: counted ? 1 : 0,
      usd: taskUsd(task),
    };
  }
  let done = 0;
  let total = 0;
  let usd = taskUsd(task);
  for (const child of children) {
    const rolled = rollUp(child, byParent);
    done += rolled.done;
    total += rolled.total;
    usd += rolled.usd;
  }
  return { done, total, usd };
}

/**
 * Agent written text, made safe to print on one line of a terminal.
 *
 * A title is written by a planner agent and can hold anything,
 * including the escape sequences that move a cursor, set a colour, or
 * clear the screen. Printed as written, one of those would rewrite
 * lines a person has already read, which is the terminal's version of
 * the rule that agent bytes never execute as the console.
 *
 * So control characters go, tabs and newlines become spaces, and the
 * result is cut to a width a terminal can hold.
 */
export function oneLine(text: string, width = 72): string {
  const flat = text
    .replaceAll(/[\t\n\r]+/g, " ")
    // C0 and C1 control characters, escape included.
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/**
 * The whole view: the swarm's headline, then its tree.
 *
 * One function so a snapshot and a live redraw print exactly the same
 * thing, and so a test can hold the whole screen rather than the tree
 * and the header separately.
 */
export function swarmView(detail: SwarmDetailResponse): string[] {
  const swarm = detail.swarm;
  const lines = swarmTreeLines(detail);
  const leaves = detail.tasks.filter((task) => task.nodeType === "leaf" && task.status !== "cancelled");
  const done = leaves.filter((task) => task.status === "done").length;
  const workers = detail.activeRuns.filter((run) => run.role === "worker").length;

  const head = [`${swarm.title}  (${swarm.slug})`, `  ${swarmWords(swarm)}`];
  head.push(`  ${done} of ${leaves.length} tasks`);
  if (workers > 0) head.push(`  ${workers} working`);
  head.push(
    `  ${money(spentUsd(swarm))}${swarm.budgetUsd === null ? "" : ` of ${money(Number(swarm.budgetUsd))}`}`,
  );
  if (swarm.branchName) head.push(`  ${swarm.branchName}`);
  if ((swarm.reopenCount ?? 0) > 0) {
    head.push(`  reopened ${swarm.reopenCount === 1 ? "once" : `${swarm.reopenCount} times`}`);
  }

  return [
    head.join(""),
    ...(lines.length > 0 ? lines : ["  The planner has not split this goal yet."]),
  ];
}
