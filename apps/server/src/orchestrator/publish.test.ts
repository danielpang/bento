import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { cloneBaseBranch, isAncestryPublishFailure, publishFeatureBranches, resolvePublishBaseSha } from "./publish.js";

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

async function seedRemote(defaultBranch: string): Promise<string> {
  const work = await mkdtemp(path.join(tmpdir(), "bento-seed-work-"));
  await git(work, "init", "-b", defaultBranch);
  await writeFile(path.join(work, "base.txt"), "base\n");
  await git(work, "add", "base.txt");
  await git(work, "commit", "-m", "base");
  const bare = await mkdtemp(path.join(tmpdir(), "bento-seed-bare-"));
  await git(bare, "init", "--bare", "-b", defaultBranch);
  await git(work, "remote", "add", "origin", bare);
  await git(work, "push", "origin", defaultBranch);
  return bare;
}

async function freshCheckout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bento-seed-co-"));
  return path.join(root, "checkout");
}

test("cloneBaseBranch returns the branch it was asked for when it exists", async () => {
  const remote = await seedRemote("master");
  const checkout = await freshCheckout();
  const resolved = await cloneBaseBranch({
    remote,
    label: "acme/app",
    baseBranch: "master",
    checkout,
    env: { ...process.env },
  });
  assert.equal(resolved, "master");
});

test("cloneBaseBranch falls back to the remote default when the stored branch is gone", async () => {
  const remote = await seedRemote("master");
  const checkout = await freshCheckout();
  const resolved = await cloneBaseBranch({
    remote,
    label: "acme/app",
    baseBranch: "main",
    checkout,
    env: { ...process.env },
  });
  assert.equal(resolved, "master");
  const { stdout } = await git(checkout, "rev-parse", "--abbrev-ref", "HEAD");
  assert.equal(stdout.trim(), "master");
});

test("cloneBaseBranch explains that an empty repository has no branches", async () => {
  const remote = await mkdtemp(path.join(tmpdir(), "bento-seed-empty-"));
  await git(remote, "init", "--bare", "-b", "main");
  const checkout = await freshCheckout();
  await assert.rejects(
    cloneBaseBranch({
      remote,
      label: "acme/empty",
      baseBranch: "main",
      checkout,
      env: { ...process.env },
    }),
    /acme\/empty has no branch named main/,
  );
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
      return { title: "Draft me", body: null, state: "open", merged: false };
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
