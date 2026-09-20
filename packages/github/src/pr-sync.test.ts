import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestMarker } from "./pr-sync.js";

test("pullRequestMarker is stable for idempotency checks", () => {
  assert.equal(pullRequestMarker("row-1"), "<!-- bento-pr-update:row-1 -->");
});
