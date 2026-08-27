import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseRepoUrl, summarizeChecks, summarizeMergeState } from "./app-client.js";
import { verifyWebhookSignature, webhookTarget } from "./webhook.js";

test("summarizeChecks counts pending and failed", () => {
  const summary = summarizeChecks([
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "neutral" },
    { status: "completed", conclusion: "skipped" },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "timed_out" },
  ]);
  assert.deepEqual(summary, { total: 6, pending: 1, failed: 2 });
});

test("summarizeChecks treats no checks as passing", () => {
  assert.deepEqual(summarizeChecks([]), { total: 0, pending: 0, failed: 0 });
});

test("summarizeMergeState answers clean, conflicted, and not-yet-computed", () => {
  assert.deepEqual(summarizeMergeState({ state: "open", merged: false, mergeable: true }), {
    state: "clean",
    open: true,
  });
  assert.deepEqual(summarizeMergeState({ state: "open", merged: false, mergeable: false }), {
    state: "conflicted",
    open: true,
  });
  // GitHub computes mergeability lazily; null is "ask again", never a conflict.
  assert.deepEqual(summarizeMergeState({ state: "open", merged: false, mergeable: null }), {
    state: "unknown",
    open: true,
  });
  // Closed and merged pull requests have nothing left to resolve.
  assert.deepEqual(summarizeMergeState({ state: "closed", merged: false, mergeable: false }), {
    state: "unknown",
    open: false,
  });
  assert.deepEqual(summarizeMergeState({ state: "closed", merged: true, mergeable: null }), {
    state: "unknown",
    open: false,
  });
});

test("parseRepoUrl handles https, ssh, and .git suffixes", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseRepoUrl("git@github.com:acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseRepoUrl("https://github.com/acme/widgets"), { owner: "acme", repo: "widgets" });
  assert.equal(parseRepoUrl("https://gitlab.com/acme/widgets"), null);
});

test("webhook signature verification accepts valid and rejects tampered", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ action: "opened" });
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(secret, body, good), true);
  assert.equal(verifyWebhookSignature(secret, body, undefined), false);
  assert.equal(verifyWebhookSignature(secret, `${body} `, good), false);
  assert.equal(verifyWebhookSignature("wrong", body, good), false);
});

test("webhookTarget extracts PR from relevant events", () => {
  const repository = { name: "widgets", owner: { login: "acme" } };
  assert.deepEqual(webhookTarget("pull_request_review_thread", { repository, pull_request: { number: 7 } }), {
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
  });
  assert.deepEqual(webhookTarget("check_suite", { repository, check_suite: { pull_requests: [{ number: 9 }] } }), {
    owner: "acme",
    repo: "widgets",
    prNumber: 9,
  });
  assert.equal(webhookTarget("push", { repository }), null);
  assert.equal(webhookTarget("check_suite", { repository, check_suite: { pull_requests: [] } }), null);
});
