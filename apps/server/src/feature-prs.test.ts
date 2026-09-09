import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestStateOf } from "./feature-prs.js";

/**
 * The history list says "Merged" or "Open" beside each pull request a
 * card has opened, and the difference between them is the difference
 * between shipped and waiting. GitHub reports a merged pull request as
 * closed, so reading state alone would call every merge a close.
 */
test("a merged pull request is not just a closed one", () => {
  assert.equal(pullRequestStateOf({ state: "closed", merged: true }), "merged");
  assert.equal(pullRequestStateOf({ state: "open", merged: false }), "open");
  assert.equal(pullRequestStateOf({ state: "closed", merged: false }), "closed");
});
