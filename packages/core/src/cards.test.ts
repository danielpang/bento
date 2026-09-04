import { test } from "node:test";
import assert from "node:assert/strict";
import { childBadgeLabel, childStatsFrom, childTone, parentDeleteRefusal } from "./cards.js";

const card = (id: string, parentId: string | null, status = "active") => ({ id, parentId, status });

test("a card with no parts has no stats to show", () => {
  const stats = childStatsFrom("p", [card("p", null)], {});
  assert.deepEqual(stats, { total: 0, running: 0, failed: 0, done: 0 });
  assert.equal(childTone(stats), "idle");
});

test("only the parts of this card are counted, not another card's", () => {
  const cards = [card("p", null), card("a", "p"), card("b", "p"), card("c", "other")];
  assert.equal(childStatsFrom("p", cards, {}).total, 2);
});

test("a finished part counts as done whatever its last run said", () => {
  // A card marked done after a run failed is done: the board card reads
  // it the same way, and a badge that disagreed would send somebody
  // looking for a failure that has already been dealt with.
  const cards = [card("p", null), card("a", "p", "done")];
  const stats = childStatsFrom("p", cards, { a: "failed" });
  assert.deepEqual(stats, { total: 1, running: 0, failed: 0, done: 1 });
  assert.equal(childTone(stats), "done");
});

test("a cancelled part is finished too, not a failure", () => {
  const stats = childStatsFrom("p", [card("p", null), card("a", "p", "cancelled")], {});
  assert.equal(stats.done, 1);
  assert.equal(stats.failed, 0);
});

test("a failed part outranks a running one in the badge's tone", () => {
  const cards = [card("p", null), card("a", "p"), card("b", "p")];
  const stats = childStatsFrom("p", cards, { a: "running", b: "failed" });
  assert.deepEqual(stats, { total: 2, running: 1, failed: 1, done: 0 });
  assert.equal(childTone(stats), "failed");
  assert.equal(childBadgeLabel(stats), "2 parts, 1 failed");
});

test("a queued part is already moving", () => {
  const stats = childStatsFrom("p", [card("p", null), card("a", "p")], { a: "queued" });
  assert.equal(childTone(stats), "running");
  assert.equal(childBadgeLabel(stats), "1 part, 1 running");
});

test("all done only when every part is", () => {
  const cards = [card("p", null), card("a", "p", "done"), card("b", "p")];
  assert.equal(childTone(childStatsFrom("p", cards, {})), "idle");
  assert.equal(childBadgeLabel(childStatsFrom("p", cards, {})), "2 parts");
});

test("the delete refusal names how many cards are in the way", () => {
  assert.equal(
    parentDeleteRefusal(1),
    "This card was split into 1 other card. Delete or finish that card first.",
  );
  assert.match(parentDeleteRefusal(3), /3 other cards/);
});
