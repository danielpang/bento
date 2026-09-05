import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { isAncestryPublishFailure, publishFeatureBranches, resolvePublishBaseSha } from "./publish.js";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return run("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@bento.dev",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@bento.dev",
    },
  });
}

test("isAncestryPublishFailure recognizes merge-base errors", () => {
  assert.equal(
    isAncestryPublishFailure("Command failed: git -C /tmp merge-base --is-ancestor abc def"),
    true,
  );
  assert.equal(isAncestryPublishFailure("not a GitHub remote"), false);
});

test("resolvePublishBaseSha uses the fork point when main moved forward", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-publish-base-"));
  await git(root, "init", "-b", "main");
  await writeFile(path.join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "base");
  const { stdout: fork } = await git(root, "rev-parse", "HEAD");

  await git(root, "checkout", "-b", "feature/behind");
  await writeFile(path.join(root, "feature.txt"), "feature\n");
  await git(root, "add", "feature.txt");
  await git(root, "commit", "-m", "feature work");

  await git(root, "checkout", "main");
  await writeFile(path.join(root, "main.txt"), "main moved\n");
  await git(root, "add", "main.txt");
  await git(root, "commit", "-m", "main moved");

  await git(root, "checkout", "feature/behind");
  const baseSha = await resolvePublishBaseSha(root, "main");
  assert.equal(baseSha, fork.trim());
});

test("draft publish opens a draft pull request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-publish-draft-"));
  await git(root, "init", "-b", "main");
  await writeFile(path.join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "base");

  const branch = "feature/draft-me";
  await git(root, "checkout", "-b", branch);
  await writeFile(path.join(root, "feature.txt"), "feature\n");
  await git(root, "add", "feature.txt");
  await git(root, "commit", "-m", "feature work");

  const bare = await mkdtemp(path.join(tmpdir(), "bento-publish-draft-bare-"));
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "remote", "add", "origin", bare);
  await git(root, "push", "origin", "main", branch);

  let draft = false;
  const publisher = {
    async pushToken() {
      return "unused";
    },
    async ensurePullRequest(input: { draft?: boolean }) {
      draft = input.draft === true;
      return { prNumber: 3, url: "https://github.com/acme/app/pull/3" };
    },
    async getPullRequest() {
      return { title: "Draft me", body: null };
    },
    async updatePullRequest() {},
    async pullRequestHasRunComment() {
      return false;
    },
    async createPullRequestComment() {},
  };

  const { published, failures } = await publishFeatureBranches(
    {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {},
        }),
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
    } as never,
    publisher,
    {
      featureId: "feature-id",
      featureTitle: "Draft me",
      branch,
      repositories: [
        {
          id: null,
          name: "app",
          repoUrl: "https://github.com/acme/app",
          defaultBranch: "main",
          worktreePath: root,
        },
      ],
    },
    { remoteUrl: () => bare, draft: true },
  );

  assert.deepEqual(failures, []);
  assert.equal(draft, true);
  assert.equal(published[0]?.draft, true);
});
