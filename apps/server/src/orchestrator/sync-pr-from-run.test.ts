import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHubPublisher } from "@bento/github";
import { syncPullRequestsFromRun } from "./sync-pr-from-run.js";

test("syncPullRequestsFromRun updates description when body is still boilerplate", async () => {
  const calls: string[] = [];
  const publisher: GitHubPublisher = {
    async ensurePullRequest() {
      return { prNumber: 1, url: "https://github.com/acme/app/pull/1" };
    },
    async pushToken() {
      return "token";
    },
    async getPullRequest() {
      return { title: "Card title", body: 'Opened by Bento for "Card title".' };
    },
    async updatePullRequest(input) {
      calls.push(`update:${input.title}:${input.body}`);
    },
    async pullRequestHasRunComment() {
      return false;
    },
    async createPullRequestComment() {},
  };

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit: async () => [
                      {
                        content: "# PR title\n\nImplementation summary.",
                        path: "docs/bento/implementation.md",
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  await syncPullRequestsFromRun(db as never, publisher, {
    runId: "run-1",
    stageSlug: "implementation",
    stageName: "Software Engineer",
    published: [
      { name: "app", repoUrl: "https://github.com/acme/app", prNumber: 1, url: "https://github.com/acme/app/pull/1" },
    ],
  });

  assert.deepEqual(calls, ["update:PR title:Implementation summary."]);
});

test("syncPullRequestsFromRun posts a code review comment once per pull request", async () => {
  const comments: string[] = [];
  const publisher: GitHubPublisher = {
    async ensurePullRequest() {
      return { prNumber: 2, url: "https://github.com/acme/app/pull/2" };
    },
    async pushToken() {
      return "token";
    },
    async getPullRequest() {
      return { title: "Card", body: "Custom body" };
    },
    async updatePullRequest() {},
    async pullRequestHasRunComment(_ref, runId) {
      return runId === "seen";
    },
    async createPullRequestComment(_ref, body) {
      comments.push(body);
    },
  };

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                orderBy() {
                  return {
                    limit: async () => [
                      {
                        content: "Looks good. One nit on error handling.",
                        path: "docs/bento/code-review.md",
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  await syncPullRequestsFromRun(db as never, publisher, {
    runId: "run-2",
    stageSlug: "code-review",
    stageName: "Code Reviewer",
    published: [
      { name: "app", repoUrl: "https://github.com/acme/app", prNumber: 2, url: "https://github.com/acme/app/pull/2" },
    ],
  });

  assert.equal(comments.length, 1);
  assert.match(comments[0]!, /Looks good/);
  assert.match(comments[0]!, /<!-- bento-run:run-2 -->/);
});

test("syncPullRequestsFromRun skips unknown stage slugs", async () => {
  let touched = false;
  const publisher: GitHubPublisher = {
    async ensurePullRequest() {
      touched = true;
      return { prNumber: 1, url: "https://github.com/acme/app/pull/1" };
    },
    async pushToken() {
      return "token";
    },
    async getPullRequest() {
      touched = true;
      return { title: "t", body: "b" };
    },
    async updatePullRequest() {
      touched = true;
    },
    async pullRequestHasRunComment() {
      touched = true;
      return false;
    },
    async createPullRequestComment() {
      touched = true;
    },
  };

  await syncPullRequestsFromRun({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) } as never, publisher, {
    runId: "run-3",
    stageSlug: "planning",
    stageName: "Planner",
    published: [
      { name: "app", repoUrl: "https://github.com/acme/app", prNumber: 1, url: "https://github.com/acme/app/pull/1" },
    ],
  });

  assert.equal(touched, false);
});
