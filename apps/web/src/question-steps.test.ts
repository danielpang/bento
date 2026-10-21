import { test } from "node:test";
import assert from "node:assert/strict";
import type { AskedQuestion } from "@bento/api-client";
import { EMPTY_DRAFT, afterAnswer, answerText, canVisit, choices, complete, nextStep, pick, reviewStep, write } from "./question-steps.js";

const db: AskedQuestion = { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] };
const features: AskedQuestion = { question: "Which features?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }, { label: "Sharing" }] };
const words: AskedQuestion = { question: "Anything else?", multiSelect: false, options: [] };
const three = [db, features, words];

test("a card of several questions ends on a review step, and a lone question has none", () => {
  assert.equal(reviewStep(three), 3);
  assert.equal(reviewStep([db]), null);
  assert.equal(nextStep(three, 0), 1);
  assert.equal(nextStep(three, 2), 3, "after the last question comes the review");
  assert.equal(nextStep(three, 3), 3);
  assert.equal(nextStep([db], 0), 0, "a lone question stays put, with Send on it");
});

test("a step opens only once every question before it is answered", () => {
  let draft = EMPTY_DRAFT;
  assert.equal(canVisit(three, draft, 0), true);
  assert.equal(canVisit(three, draft, 1), false, "no skipping ahead");
  draft = pick(draft, db, "SQLite", true);
  assert.equal(canVisit(three, draft, 1), true);
  assert.equal(canVisit(three, draft, 3), false, "the review waits for every answer");
  draft = pick(draft, features, "Export", true);
  draft = write(draft, words, "Ship it Friday");
  assert.equal(canVisit(three, draft, 3), true);
  assert.equal(canVisit(three, draft, 0), true, "going back is always allowed");
  assert.equal(canVisit(three, draft, 4), false);
});

test("going back and changing an answer keeps the others", () => {
  let draft = pick(EMPTY_DRAFT, db, "Postgres", true);
  draft = pick(draft, features, "Search", true);
  draft = pick(draft, features, "Export", true);
  draft = pick(draft, db, "SQLite", true);
  assert.equal(answerText(db, draft), "SQLite", "a single choice holds one answer");
  assert.equal(answerText(features, draft), "Search, Export");
  draft = pick(draft, features, "Search", false);
  assert.equal(answerText(features, draft), "Export");
});

test("own words replace a single choice and join a multiple one, in the offered order", () => {
  let draft = pick(EMPTY_DRAFT, db, "Postgres", true);
  draft = write(draft, db, "DynamoDB");
  assert.equal(answerText(db, draft), "DynamoDB");
  draft = pick(draft, db, "SQLite", true);
  assert.equal(answerText(db, draft), "SQLite", "and an option replaces the words again");
  draft = pick(draft, features, "Export", true);
  draft = pick(draft, features, "Search", true);
  draft = write(draft, features, "  Webhooks ");
  assert.equal(answerText(features, draft), "Search, Export, Webhooks");
  assert.equal(answerText(words, write(draft, words, "   ")), null, "blank words are no answer");
});

test("the choices sent are what the route checks", () => {
  let draft = pick(EMPTY_DRAFT, db, "SQLite", true);
  draft = pick(draft, features, "Search", true);
  draft = write(draft, features, "Webhooks");
  assert.equal(complete(three, draft), false);
  draft = write(draft, words, "Friday");
  assert.equal(complete(three, draft), true);
  assert.deepEqual(choices(three, draft), [
    { question: "Which database?", selected: ["SQLite"] },
    { question: "Which features?", selected: ["Search"], other: "Webhooks" },
    { question: "Anything else?", selected: [], other: "Friday" },
  ]);
});

test("a tap moves to the next question that needs an answer, or to the review", () => {
  let draft = pick(EMPTY_DRAFT, db, "SQLite", true);
  assert.equal(afterAnswer(three, draft, 0), 1);
  draft = pick(draft, features, "Search", true);
  draft = write(draft, words, "Friday");
  draft = pick(draft, db, "Postgres", true);
  assert.equal(afterAnswer(three, draft, 0), 3, "changed from the review: straight back to it");
  assert.equal(afterAnswer([db], draft, 0), 0, "a lone question stays put");
});
