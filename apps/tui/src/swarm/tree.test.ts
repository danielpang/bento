import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import type { SwarmDetailResponse, SwarmRow, SwarmSummaryRow, SwarmTaskRow } from "@bento/api-client";
import { oneLine, rollUp, swarmTreeLines, swarmView, swarmWords } from "./tree.js";
import { findSwarm, isOver, summaryLine, watchSwarm, type SwarmClient, type SwarmCommandIo } from "./command.js";

/**
 * What `bento swarm` puts on a terminal.
 *
 * The drawing is pure, so it is held here with no server and no
 * screen: rows in, lines out. Two of these are about safety rather
 * than layout, and they are the ones that matter most. A node's title
 * is written by a planner agent, so an escape sequence in one must not
 * reach a terminal; and a tree that came from an agent can name itself
 * as its own ancestor, which must not be an infinite loop in somebody's
 * shell.
 */

const swarm: SwarmRow = {
  id: "sw-1",
  projectId: "p1",
  slug: "checkout",
  title: "Rewrite the checkout",
  goal: "Replace the checkout with the hosted card field.",
  status: "running",
  pausedReason: null,
  branchName: "swarm/checkout",
  budgetUsd: "40",
  maxWorkers: 4,
  timeLimitMin: null,
  spentMeasuredUsd: "3.50",
  spentEstimatedUsd: "1.25",
  spentAssumedUsd: "0",
  spentNotionalUsd: "9.99",
  archivedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function task(over: Partial<SwarmTaskRow> & Pick<SwarmTaskRow, "id">): SwarmTaskRow {
  return {
    parentId: null,
    position: 0,
    nodeType: "leaf",
    title: over.id,
    description: "",
    status: "open",
    attention: null,
    weight: 1,
    branchName: null,
    costMeasuredUsd: "0",
    costEstimatedUsd: "0",
    costAssumedUsd: "0",
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

function detail(tasks: SwarmTaskRow[], over: Partial<SwarmRow> = {}): SwarmDetailResponse {
  return { swarm: { ...swarm, ...over }, tasks, activeRuns: [] };
}

test("the tree draws the plan's shape, with each node's state and cost", () => {
  const lines = swarmTreeLines(
    detail([
      task({ id: "cart", nodeType: "plan", title: "Cart", status: "working", position: 0 }),
      task({
        id: "totals",
        parentId: "cart",
        title: "Line item totals",
        status: "done",
        position: 0,
        costMeasuredUsd: "1.20",
      }),
      task({ id: "refund", parentId: "cart", title: "Refund path", status: "working", position: 1 }),
      task({ id: "pay", nodeType: "plan", title: "Payments", status: "open", position: 1 }),
    ]),
  );

  assert.deepEqual(lines, [
    "├─ ▸ Cart  1/2  $1.20",
    "│  ├─ ✓ Line item totals  done  $1.20",
    "│  └─ ▸ Refund path  working",
    "└─ · Payments  0/0",
  ]);
});

test("a node waiting on a person says what it is waiting for", () => {
  const lines = swarmTreeLines(
    detail([task({ id: "x", title: "Refund path", status: "working", attention: "long_running" })]),
  );
  assert.deepEqual(lines, ["└─ ▸ Refund path  working  running long"]);
});

test("a follow up subtree is labelled with what it was reopened for", () => {
  const lines = swarmTreeLines(
    detail([
      task({ id: "first", nodeType: "plan", title: "Cart", status: "done", position: 0 }),
      task({
        id: "follow",
        nodeType: "plan",
        title: "Follow up 1",
        status: "working",
        position: 1,
        followUpInstruction: "Address the review comments on the totals module.",
      }),
      task({ id: "rename", parentId: "follow", title: "Rename the helper", status: "working" }),
    ]),
  );
  assert.deepEqual(lines, [
    "├─ ✓ Cart  0/0",
    "└─ ▸ Follow up 1  0/1",
    "      follow up: Address the review comments on the totals module.",
    "   └─ ▸ Rename the helper  working",
  ]);
});

test("a cancelled leaf is not counted, so a finished node reads as finished", () => {
  const rows = [
    task({ id: "plan", nodeType: "plan", title: "Cart", status: "done" }),
    task({ id: "a", parentId: "plan", status: "done" }),
    task({ id: "b", parentId: "plan", status: "cancelled" }),
  ];
  const byParent = new Map<string | null, SwarmTaskRow[]>();
  for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  assert.deepEqual(rollUp(rows[0]!, byParent), { done: 1, total: 1, usd: 0 });
});

test("a title an agent wrote cannot move the cursor or clear the screen", () => {
  /**
   * A planner's title reaches a terminal, and a terminal executes
   * escape sequences. Printed as written, one of these would rewrite
   * lines a person has already read, which is this product's rule
   * about agent bytes in the place a terminal has it.
   */
  const nasty = "\u001b[2JCleared\u001b[H\u0007 and\ttabbed\nand newlined";
  assert.equal(oneLine(nasty), "[2JCleared[H and tabbed and newlined");
  const lines = swarmTreeLines(detail([task({ id: "x", title: nasty })]));
  assert.ok(!lines.join("\n").includes("\u001b"), "no escape reaches the terminal");
  assert.ok(!lines.join("\n").includes("\u0007"), "and no bell");
});

test("a very long title is cut rather than wrapped across the tree", () => {
  const long = "x".repeat(200);
  const [line] = swarmTreeLines(detail([task({ id: "x", title: long })]));
  assert.ok(line!.length < 120);
  assert.ok(line!.includes("…"));
});

test("a tree that names itself as its own ancestor draws once and stops", () => {
  /**
   * parentId comes from an agent. Two nodes naming each other is a
   * loop, and a loop here is a terminal that never returns.
   */
  const lines = swarmTreeLines(
    detail([
      task({ id: "a", parentId: "b", title: "A" }),
      task({ id: "b", parentId: "a", title: "B" }),
      task({ id: "c", title: "C" }),
    ]),
  );
  assert.equal(lines.filter((line) => line.includes("A")).length, 0, "a node with no reachable root is not drawn");
  assert.deepEqual(lines, ["└─ · C  open"]);
});

test("the headline says where the swarm is, what it has done, and what it cost", () => {
  const view = swarmView(
    detail(
      [
        task({ id: "a", title: "One", status: "done" }),
        task({ id: "b", title: "Two", status: "working" }),
      ],
      { reopenCount: 2 },
    ),
  );
  assert.match(view[0]!, /Rewrite the checkout {2}\(checkout\)/);
  assert.match(view[0]!, /running/);
  assert.match(view[0]!, /1 of 2 tasks/);
  assert.match(view[0]!, /\$4\.75 of \$40\.00/, "the three enforced tiers, not the notional one");
  assert.match(view[0]!, /swarm\/checkout/);
  assert.match(view[0]!, /reopened 2 times/);
});

test("a swarm's state is said in the words the console uses", () => {
  assert.equal(swarmWords({ status: "cancelled", pausedReason: null }), "stopped");
  assert.equal(swarmWords({ status: "blocked", pausedReason: null }), "waiting on you");
  assert.equal(swarmWords({ status: "budget_exhausted", pausedReason: "budget" }), "out of budget");
  assert.equal(swarmWords({ status: "timed_out", pausedReason: "time_limit" }), "out of time");
  assert.equal(swarmWords({ status: "paused", pausedReason: "plan_limit" }), "paused, out of agent hours");
  assert.equal(swarmWords({ status: "paused", pausedReason: "manual" }), "paused");
});

/* ---------------------------------------------------------------- *
 * The commands themselves.
 * ---------------------------------------------------------------- */

function summary(over: Partial<SwarmSummaryRow> & Pick<SwarmSummaryRow, "id" | "slug">): SwarmSummaryRow {
  return { ...swarm, title: over.slug, counts: { tasks: 2, done: 1, attention: 0 }, ...over };
}

test("a swarm is named by id, by slug, or by title, and an ambiguous name is refused", () => {
  const rows = [
    summary({ id: "sw-1", slug: "checkout", title: "Checkout" }),
    summary({ id: "sw-2", slug: "checkout-2", title: "Checkout" }),
  ];
  assert.deepEqual(findSwarm(rows, "sw-2"), { swarm: rows[1] });
  assert.deepEqual(findSwarm(rows, "checkout-2"), { swarm: rows[1] });
  const both = findSwarm(rows, "Checkout");
  assert.ok("refused" in both);
  assert.match(both.refused, /several swarms are called "Checkout"/);
  assert.match(both.refused, /sw-1, sw-2/, "and it names them, so the next attempt can be exact");

  const none = findSwarm(rows, "nope");
  assert.ok("refused" in none);
  assert.match(none.refused, /no swarm called "nope"/);
  const empty = findSwarm([], "x");
  assert.ok("refused" in empty);
  assert.match(empty.refused, /no swarms yet/);
});

test("a list row carries the state, the count, and the spend", () => {
  const line = summaryLine(
    summary({ id: "sw-1", slug: "checkout", title: "Rewrite the checkout", counts: { tasks: 6, done: 4, attention: 1 } }),
  );
  assert.deepEqual(line.split("\t"), [
    "checkout",
    "running",
    "4/6",
    "1 waiting on you",
    "$4.75 of $40.00",
    "Rewrite the checkout",
  ]);
});

test("watching redraws when the swarm changes, and ends when the swarm does", async () => {
  /**
   * The exit criterion for the terminal: a live tree. What is checked
   * here is that a frame causes a refetch and a redraw, that a burst
   * costs one round trip rather than one each, and that a finished
   * swarm closes the stream rather than leaving a terminal watching
   * something that will never move again.
   */
  const states: SwarmDetailResponse[] = [
    detail([task({ id: "a", title: "One", status: "working" })]),
    detail([task({ id: "a", title: "One", status: "done" })], { status: "done" }),
  ];
  let reads = 0;
  let wake: (() => void) | null = null;
  let closed = false;

  const lines: string[] = [];
  const io: SwarmCommandIo = { out: (line) => lines.push(line), err: () => {}, fail: () => {} };

  const client = {
    getSwarm: () => {
      const next = states[Math.min(reads, states.length - 1)]!;
      reads += 1;
      return Promise.resolve(next);
    },
    streamSwarm: (_id: string, onEvent: () => void) => {
      wake = onEvent;
      return () => {
        closed = true;
      };
    },
  } as unknown as SwarmClient;

  const watching = watchSwarm(client, "sw-1", io, { settleMs: 1 });
  // Let the first read and draw happen before anything is emitted.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reads, 1, "one read to draw the first tree");
  assert.ok(lines.some((line) => line.includes("One  working")));

  // Three frames in a burst, which is what a swarm touching three
  // nodes at once looks like.
  wake!();
  wake!();
  wake!();
  await watching;

  assert.equal(reads, 2, "the burst cost one refetch, not three");
  assert.ok(lines.some((line) => line.includes("One  done")), "and the tree was redrawn");
  assert.equal(closed, true, "a finished swarm closes the stream");
});

test("a swarm that is already over is drawn once and not watched", async () => {
  const finished = detail([task({ id: "a", status: "done" })], { status: "done" });
  let subscribed = false;
  const client = {
    getSwarm: () => Promise.resolve(finished),
    streamSwarm: () => {
      subscribed = true;
      return () => {};
    },
  } as unknown as SwarmClient;

  await watchSwarm(client, "sw-1", { out: () => {}, err: () => {}, fail: () => {} }, { settleMs: 1 });
  assert.equal(subscribed, false, "nothing subscribes to a swarm that will never move again");
  assert.equal(isOver(finished), true);
});

test("no dash reaches a terminal, in any of the swarm command's source", () => {
  /**
   * The console has this test over its own swarm files, and a terminal
   * is no less a place a person reads. The rule bit here once already:
   * the glyph for a cancelled node was an en dash.
   */
  const offenders: string[] = [];
  for (const name of readdirSync(new URL(".", import.meta.url))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const text = readFileSync(new URL(name, import.meta.url), "utf8");
    if (text.includes("—") || text.includes("–")) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
