import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBentoDefaultPullRequestBody,
  parseStageWriteUpForPullRequest,
  pullRequestRunMarker,
} from "./pr-sync.js";

test("isBentoDefaultPullRequestBody recognizes boilerplate and empty bodies", () => {
  assert.equal(isBentoDefaultPullRequestBody(null), true);
  assert.equal(isBentoDefaultPullRequestBody(""), true);
  assert.equal(isBentoDefaultPullRequestBody('Opened by Bento for "Add widgets".'), true);
  assert.equal(isBentoDefaultPullRequestBody("## Summary\nShipped widgets."), false);
});

test("parseStageWriteUpForPullRequest splits a leading H1 into title and body", () => {
  assert.deepEqual(parseStageWriteUpForPullRequest("# Add widget API\n\nImplements the endpoint."), {
    title: "Add widget API",
    body: "Implements the endpoint.",
  });
  assert.deepEqual(parseStageWriteUpForPullRequest("Plain summary without a heading."), {
    body: "Plain summary without a heading.",
  });
});

test("pullRequestRunMarker is stable for idempotency checks", () => {
  assert.equal(pullRequestRunMarker("run-1"), "<!-- bento-run:run-1 -->");
});
