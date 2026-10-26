import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPullRequestBody, GITHUB_BODY_MAX_CHARS, pullRequestMarker } from "./pr-sync.js";

test("fitPullRequestBody keeps a short body and cuts a long one to GitHub's limit", () => {
  assert.equal(fitPullRequestBody("short", "\n\nmarker"), "short\n\nmarker");

  const marker = pullRequestMarker("abc");
  const fitted = fitPullRequestBody("x".repeat(100_000), marker);
  assert.equal(fitted.length, GITHUB_BODY_MAX_CHARS);
  assert.ok(fitted.endsWith(`allows.)${marker}`));

  const emoji = fitPullRequestBody("😀".repeat(40_000));
  assert.ok(emoji.length <= GITHUB_BODY_MAX_CHARS);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));
});

test("pullRequestMarker is stable for idempotency checks", () => {
  assert.equal(pullRequestMarker("row-1"), "<!-- bento-pr-update:row-1 -->");
});
