import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSIONS_LIST_DEFAULT, SESSIONS_LIST_MAX, SESSIONS_LIST_MIN, clampListWidth } from "./sessions-split.js";

test("a dragged list width stays between its minimum and maximum", () => {
  assert.equal(clampListWidth(100, 2000), SESSIONS_LIST_MIN);
  assert.equal(clampListWidth(5000, 4000), SESSIONS_LIST_MAX);
  assert.equal(clampListWidth(400.4, 2000), 400);
});

test("the conversation keeps its share of a narrow screen", () => {
  // 60% of 800 is 480, under the 640 maximum.
  assert.equal(clampListWidth(600, 800), 480);
  // A screen so narrow the share is below the minimum still gets the minimum.
  assert.equal(clampListWidth(600, 300), SESSIONS_LIST_MIN);
});

test("a width that is not a number falls back to the default", () => {
  assert.equal(clampListWidth(Number.NaN, 2000), SESSIONS_LIST_DEFAULT);
});
