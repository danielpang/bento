import assert from "node:assert/strict";
import test from "node:test";
import { githubIssueUrl, ISSUES_URL } from "./github-issue.js";

test("a contact message becomes a prefilled GitHub issue", () => {
  const url = new URL(githubIssueUrl("issue", "  Swarm hangs\nNo agent output for 25 minutes.  "));
  assert.equal(`${url.origin}${url.pathname}`, `${ISSUES_URL}/new`);
  assert.equal(url.searchParams.get("title"), "Swarm hangs");
  assert.equal(url.searchParams.get("body"), "Swarm hangs\nNo agent output for 25 minutes.");
  assert.equal(url.searchParams.get("labels"), "bug");
  assert.equal(new URL(githubIssueUrl("feature", "x")).searchParams.get("labels"), "enhancement");
});

test("a long title is shortened and a long body is cut to fit the link", () => {
  const message = `${"a".repeat(200)}\n${"é & ".repeat(5000)}`;
  const link = githubIssueUrl("issue", message);
  assert.ok(link.length <= 7500, `link is ${link.length} characters`);
  const url = new URL(link);
  assert.equal(url.searchParams.get("title")!.length, 80);
  const body = url.searchParams.get("body")!;
  assert.ok(message.startsWith(body.slice(0, body.indexOf("\n\n(The rest"))));
  assert.match(body, /did not fit in the link/);
});
