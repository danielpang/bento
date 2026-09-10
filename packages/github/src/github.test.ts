import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseRepoUrl, summarizeChecks, summarizeMergeState } from "./app-client.js";
import { pushTarget, verifyWebhookSignature, webhookTarget } from "./webhook.js";

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
  assert.deepEqual(summarizeMergeState({ state: "open", merged: false, mergeable: true }), { state: "clean" });
  assert.deepEqual(summarizeMergeState({ state: "open", merged: false, mergeable: false }), { state: "conflicted" });
  // GitHub computes mergeability lazily; null is "ask again", never a conflict.
  assert.deepEqual(summarizeMergeState({ state: "open", merged: false, mergeable: null }), { state: "unknown" });
  // Closed and merged pull requests have nothing left to resolve.
  assert.deepEqual(summarizeMergeState({ state: "closed", merged: false, mergeable: false }), { state: "unknown" });
  assert.deepEqual(summarizeMergeState({ state: "closed", merged: true, mergeable: null }), { state: "unknown" });
});

test("parseRepoUrl handles https, ssh, and .git suffixes", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseRepoUrl("git@github.com:acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseRepoUrl("https://github.com/acme/widgets"), { owner: "acme", repo: "widgets" });
  assert.equal(parseRepoUrl("https://gitlab.com/acme/widgets"), null);
});

test("parseRepoUrl keeps dots in repository names", () => {
  assert.deepEqual(parseRepoUrl("https://github.com/acme/design.system"), { owner: "acme", repo: "design.system" });
  assert.deepEqual(parseRepoUrl("git@github.com:acme/foo.bar.git"), { owner: "acme", repo: "foo.bar" });
  assert.deepEqual(parseRepoUrl("https://github.com/acme/docs.github.io/"), { owner: "acme", repo: "docs.github.io" });
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

test("pushTarget names the branch and every path the push touched", () => {
  const target = pushTarget("push", {
    ref: "refs/heads/main",
    repository: { name: "widgets", owner: { login: "acme" } },
    commits: [
      { added: [".bento/pipeline.yaml"], modified: [], removed: [] },
      { added: [], modified: ["README.md"], removed: ["old.txt"] },
    ],
    head_commit: { added: [], modified: ["README.md"], removed: [] },
  });
  assert.ok(target);
  assert.equal(target.owner, "acme");
  assert.equal(target.repo, "widgets");
  assert.equal(target.branch, "main");
  assert.deepEqual([...target.paths].sort(), [".bento/pipeline.yaml", "README.md", "old.txt"]);
});

test("pushTarget ignores tags, deleted branches, and other events", () => {
  const repository = { name: "widgets", owner: { login: "acme" } };
  assert.equal(pushTarget("push", { ref: "refs/tags/v1", repository, commits: [] }), null);
  assert.equal(pushTarget("push", { ref: "refs/heads/gone", deleted: true, repository, commits: [] }), null);
  assert.equal(pushTarget("pull_request", { ref: "refs/heads/main", repository }), null);
});
