import assert from "node:assert/strict";
import test from "node:test";
import { matchesQuery } from "./components/Board.js";

/**
 * The board's search, on its own.
 *
 * These are the shapes a ticket id arrives in when somebody reads one
 * off a Linear tab and types it here. Getting any of them wrong shows
 * an empty board, which reads as "no such card" rather than as "your
 * punctuation did not match mine".
 */
const card = { title: "ENG-441 Rework the mobile topbar", description: "The chrome wraps below 720px." };

test("an empty query keeps every card", () => {
  assert.equal(matchesQuery(card, ""), true);
  assert.equal(matchesQuery(card, "   "), true);
});

test("a ticket id matches however its punctuation is typed", () => {
  for (const query of ["ENG-441", "eng-441", "eng441", "ENG 441", "441"]) {
    assert.equal(matchesQuery(card, query), true, query);
  }
});

test("a near miss on the number does not match", () => {
  assert.equal(matchesQuery(card, "ENG-442"), false);
  assert.equal(matchesQuery(card, "eng442"), false);
});

test("the description is searched too", () => {
  assert.equal(matchesQuery(card, "wraps"), true);
  assert.equal(matchesQuery(card, "720px"), true);
});

test("a card with no description is not a crash", () => {
  assert.equal(matchesQuery({ title: "Untitled", description: "" }, "untitled"), true);
  assert.equal(matchesQuery({ title: "Untitled", description: "" }, "chrome"), false);
});

test("every term has to land, so more words narrow", () => {
  assert.equal(matchesQuery(card, "topbar mobile"), true);
  assert.equal(matchesQuery(card, "topbar drawer"), false);
});

/**
 * Punctuation on its own is not a search, and the two ways of treating
 * it as one are both wrong: matched literally, a stray dash filters the
 * board down to whichever titles happen to be hyphenated; squashed to
 * the empty string, it matches everything, since "" is a substring of
 * every string. Dropped, a half-typed id behaves like the query it is
 * on its way to being.
 */
test("punctuation on its own is not a search", () => {
  const plain = { title: "Plain", description: "" };
  const hyphenated = { title: "ENG-1 Something", description: "" };
  // Neither card is filtered out, and neither is singled out.
  assert.equal(matchesQuery(plain, "-"), true);
  assert.equal(matchesQuery(hyphenated, "-"), true);
  // A trailing dash mid-type changes nothing about the term before it.
  assert.equal(matchesQuery(card, "eng-441 -"), true);
  assert.equal(matchesQuery(card, "eng-442 -"), false);
});
