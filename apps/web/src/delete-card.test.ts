import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRun, Feature, Stage } from "@bento/api-client";
import { neighbourCardId } from "./components/Board.js";
import { deleteConsequences } from "./components/delete-consequences.js";

/**
 * The two pieces of the delete that are decisions rather than plumbing:
 * where a keyboard lands afterwards, and what the dialog claims is
 * about to happen. Both are wrong in ways a running server would not
 * complain about, which is what makes them worth pinning here.
 */

const stages = [{ id: "build" }, { id: "review" }] as Stage[];

function card(id: string, at: Partial<Feature> = {}): Feature {
  return { id, status: "active", currentStageId: null, ...at } as Feature;
}

test("focus goes to the card that took the deleted one's place", () => {
  const board = [card("a"), card("b"), card("c")];
  assert.equal(neighbourCardId(board, stages, "a"), "b");
  assert.equal(neighbourCardId(board, stages, "b"), "c");
});

test("the last card in the board hands focus back to the one before it", () => {
  assert.equal(neighbourCardId([card("a"), card("b")], stages, "b"), "a");
});

test("the only card on the board leaves nothing to focus", () => {
  // The caller falls back to the lane's own control, which is the one
  // thing still on the screen.
  assert.equal(neighbourCardId([card("a")], stages, "a"), null);
  assert.equal(neighbourCardId([], stages, "a"), null);
});

test("the neighbour is read in the order the board draws, not the order the list arrives", () => {
  // Backlog, then each stage in pipeline order, then the finished
  // cards: the list from the server is in none of those orders.
  const board = [
    card("done-1", { status: "done", currentStageId: "review" }),
    card("review-1", { currentStageId: "review" }),
    card("backlog-1"),
    card("build-1", { currentStageId: "build" }),
  ];
  assert.equal(neighbourCardId(board, stages, "backlog-1"), "build-1");
  assert.equal(neighbourCardId(board, stages, "build-1"), "review-1");
  assert.equal(neighbourCardId(board, stages, "review-1"), "done-1");
  assert.equal(neighbourCardId(board, stages, "done-1"), "review-1");
});

function finishedRun(costUsd: string | null): AgentRun {
  return { id: `run-${costUsd}`, status: "succeeded", costUsd } as AgentRun;
}

const untouched = { branchName: null };
const worked = { branchName: "bento/add-a-rate-limit" };

test("a card nothing has run on says nothing else goes with it", () => {
  const body = deleteConsequences(untouched, [], []);
  assert.match(body, /Nothing has run on this card/);
  assert.doesNotMatch(body, /sandbox/, "there is no sandbox to throw away");
  assert.match(body, /There is no undo\./);
});

test("one run is worded as one run", () => {
  // "Its 1 run goes with it" reads badly enough to be worth its own
  // sentence.
  const body = deleteConsequences(worked, [finishedRun("1.50")], []);
  assert.match(body, /Its single run goes with it, transcript and recorded spend included/);
  assert.doesNotMatch(body, /Its 1 run/);
});

test("the spend clause names the figure, and is dropped when no run reported one", () => {
  const measured = deleteConsequences(worked, [finishedRun("10.00"), finishedRun("2.40")], []);
  assert.match(measured, /Its 2 runs go with it, transcripts and recorded spend included, so this project's spend drops by \$12\.40\./);

  // Most tools print no cost at all, and a figure that is really a
  // floor would be worse than no figure.
  const silent = deleteConsequences(worked, [finishedRun(null), finishedRun(null)], []);
  assert.match(silent, /transcripts and recorded spend included\./);
  assert.doesNotMatch(silent, /\$/);
});

test("a judge run is deleted with the card but does not change the spend drop", () => {
  const judge = { ...finishedRun("99.00"), id: "judge", role: "judge" as const };
  const body = deleteConsequences(worked, [finishedRun("10.00"), judge], []);
  assert.match(body, /Its 2 runs go with it/);
  assert.match(body, /spend drops by \$10\.00/);
  assert.doesNotMatch(body, /109/);
});

test("the branch is promised by name, and not promised when there is none", () => {
  const named = deleteConsequences(worked, [finishedRun(null)], []);
  assert.match(named, /The branch bento\/add-a-rate-limit is left alone, and any pull request stays open\./);
  assert.doesNotMatch(deleteConsequences(untouched, [finishedRun(null)], []), /The branch/);
});

/**
 * The clause the design cares most about. The predictable wrong belief
 * about a delete button on a card is that it takes the code with it,
 * and both directions of that belief lose something.
 */
test("an open pull request is named, and said to stay open", () => {
  const one = deleteConsequences(worked, [finishedRun(null)], [{ number: 12 }]);
  assert.match(one, /Bento stops tracking pull request #12\. It stays open on GitHub/);

  // A card spanning two repositories has one in each, and naming only
  // the first would leave the other quietly untracked.
  const two = deleteConsequences(worked, [finishedRun(null)], [{ number: 12 }, { number: 13 }]);
  assert.match(two, /Bento stops tracking pull requests #12, #13\. They stay open on GitHub/);
});

test("every worked card is told its sandbox goes and that there is no undo", () => {
  assert.match(deleteConsequences(worked, [finishedRun(null)], []), /Its sandbox is thrown away, and there is no undo\.$/);
});
