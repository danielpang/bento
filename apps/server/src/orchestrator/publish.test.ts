import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  cloneBaseBranch,
  cloneUrlForSeed,
  createRepositorySeed,
  inaccessibleCloneExplanation,
  isAncestryPublishFailure,
  isRepositoryAccessError,
  publishFeatureBranches,
  RepositoryAccessError,
  resolvePublishBaseSha,
} from "./publish.js";

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

function listen(respond: (res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    respond(res);
    req.resume();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
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
    fallbackToDefaultBranch: true,
  });
  assert.equal(resolved, "master");
  const { stdout } = await git(checkout, "rev-parse", "--abbrev-ref", "HEAD");
  assert.equal(stdout.trim(), "master");
});

test("cloneBaseBranch reports a missing branch when the fallback is off", async () => {
  const remote = await seedRemote("master");
  const checkout = await freshCheckout();
  await assert.rejects(
    cloneBaseBranch({
      remote,
      label: "acme/app",
      baseBranch: "main",
      checkout,
      env: { ...process.env },
    }),
    /acme\/app has no branch named main/,
  );
});

test("an inaccessible GitHub repository is explained without the git command", () => {
  const err = Object.assign(
    new Error(
      'Command failed: git -c credential.helper= -c credential.helper=!f() { echo username=x-access-token; echo "password=$BENTO_PUSH_TOKEN"; }; f clone --single-branch --branch main https://github.com/acme/missing.git /tmp/bento-seed-x/checkout',
    ),
    {
      stderr:
        "remote: Repository not found.\nfatal: repository 'https://github.com/acme/missing.git/' not found\n",
    },
  );
  const sentence = inaccessibleCloneExplanation("acme/missing", "https://github.com/acme/missing.git", err);
  assert.match(sentence ?? "", /acme\/missing could not be cloned/);
  assert.match(sentence ?? "", /GitHub connection cannot see a private repository/);
  assert.match(sentence ?? "", /Settings, GitHub/);
  assert.doesNotMatch(sentence ?? "", /Command failed|credential\.helper|BENTO_PUSH_TOKEN/);
});

test("rejected GitHub credentials name the GitHub connection", () => {
  const err = Object.assign(new Error("Command failed: git clone"), {
    stderr: "fatal: Authentication failed for 'https://github.com/acme/private.git/'",
  });
  const sentence = inaccessibleCloneExplanation("acme/private", "https://github.com/acme/private.git", err);
  assert.match(sentence ?? "", /GitHub rejected the credentials/);
  assert.match(sentence ?? "", /Settings, GitHub/);
});

test("a missing branch is not reported as a missing repository", () => {
  const err = Object.assign(new Error("Command failed: git clone"), {
    stderr: "fatal: Remote branch main not found in upstream origin",
  });
  assert.equal(
    inaccessibleCloneExplanation("acme/app", "https://github.com/acme/app.git", err),
    null,
  );
});

test("a network failure is left for the caller", () => {
  const err = Object.assign(new Error("Command failed: git clone"), {
    stderr: "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
  });
  assert.equal(
    inaccessibleCloneExplanation("acme/app", "https://github.com/acme/app.git", err),
    null,
  );
});

test("cloneBaseBranch explains a repository the remote will not show", async () => {
  const server = await listen((res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Repository not found\n");
  });
  const checkout = await freshCheckout();
  try {
    await assert.rejects(
      cloneBaseBranch({
        remote: `${server.url}/acme/missing.git`,
        label: "acme/missing",
        baseBranch: "main",
        checkout,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        fallbackToDefaultBranch: true,
      }),
      (err: unknown) => {
        assert.ok(err instanceof RepositoryAccessError);
        assert.match(err.message, /acme\/missing could not be cloned from http:\/\/127\.0\.0\.1:\d+\/acme\/missing\.git/);
        assert.match(err.message, /repository was not found/);
        assert.doesNotMatch(err.message, /Command failed|credential\.helper|BENTO_PUSH_TOKEN|\/tmp\/bento-seed/);
        const cause = err.cause;
        assert.ok(cause instanceof Error);
        assert.match(cause.message, /not found/i);
        assert.doesNotMatch(cause.message, /credential\.helper|BENTO_PUSH_TOKEN|Command failed/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("createRepositorySeed clones the repository GitHub returns, not a stale id", async () => {
  const bare = await seedRemote("main");
  const tokens: Array<number | undefined> = [];
  const { bundle, baseBranch } = await createRepositorySeed(
    {
      async pushToken(id?: number) {
        tokens.push(id);
        return "unused";
      },
      async resolveRepository() {
        return {
          id: 42,
          name: "bento-cloud",
          fullName: "danielpang/bento-cloud",
          owner: "danielpang",
          url: "https://github.com/danielpang/bento-cloud",
          cloneUrl: bare,
          defaultBranch: "main",
          canClone: true,
        };
      },
    },
    "https://github.com/danielpang/old-name",
    7,
    "main",
  );
  assert.deepEqual(tokens, [42]);
  assert.equal(baseBranch, "main");
  assert.ok(bundle.length > 0);
});

test("createRepositorySeed stops when GitHub will not show the repository", async () => {
  const tokens: Array<number | undefined> = [];
  await assert.rejects(
    createRepositorySeed(
      {
        async pushToken(id?: number) {
          tokens.push(id);
          return "unused";
        },
        async resolveRepository() {
          return null;
        },
      },
      "https://github.com/danielpang/bento-cloud",
      42,
      "main",
    ),
    (err: unknown) => {
      assert.ok(isRepositoryAccessError(err));
      assert.match(err.message, /danielpang\/bento-cloud could not be cloned/);
      assert.match(err.message, /GitHub connection cannot see a private repository/);
      assert.doesNotMatch(err.message, /Command failed|credential\.helper|BENTO_PUSH_TOKEN/);
      return true;
    },
  );
  assert.deepEqual(tokens, []);
});

test("createRepositorySeed stops when the connection cannot read the repository", async () => {
  const tokens: Array<number | undefined> = [];
  await assert.rejects(
    createRepositorySeed(
      {
        async pushToken(id?: number) {
          tokens.push(id);
          return "unused";
        },
        async resolveRepository() {
          return {
            id: 42,
            name: "bento-cloud",
            fullName: "danielpang/bento-cloud",
            owner: "danielpang",
            url: "https://github.com/danielpang/bento-cloud",
            cloneUrl: "https://github.com/danielpang/bento-cloud.git",
            defaultBranch: "main",
            canClone: false,
          };
        },
      },
      "https://github.com/danielpang/bento-cloud",
      7,
      "main",
    ),
    (err: unknown) => {
      assert.ok(isRepositoryAccessError(err));
      assert.match(err.message, /cannot read the repository/);
      assert.match(err.message, /Contents access/);
      return true;
    },
  );
  assert.deepEqual(tokens, []);
});

test("createRepositorySeed retries a scoped token with the installation token", async () => {
  let requests = 0;
  const server = await listen((res) => {
    requests += 1;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Repository not found\n");
  });
  const tokens: Array<number | undefined> = [];
  try {
    await assert.rejects(
      createRepositorySeed(
        {
          async pushToken(id?: number) {
            tokens.push(id);
            return id === undefined ? "installation" : "scoped";
          },
          async resolveRepository() {
            return {
              id: 42,
              name: "missing",
              fullName: "acme/missing",
              owner: "acme",
              url: `${server.url}/acme/missing`,
              cloneUrl: `${server.url}/acme/missing.git`,
              defaultBranch: "main",
              canClone: true,
            };
          },
        },
        "https://github.com/acme/missing",
        7,
        "main",
      ),
      (err: unknown) => {
        assert.ok(isRepositoryAccessError(err));
        assert.match(err.message, /acme\/missing could not be cloned/);
        return true;
      },
    );
    assert.deepEqual(tokens, [42, undefined]);
    assert.equal(requests, 2);
  } finally {
    await server.close();
  }
});

test("createRepositorySeed does not clone twice when the token ignores the repository id", async () => {
  let requests = 0;
  const server = await listen((res) => {
    requests += 1;
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Repository not found\n");
  });
  try {
    await assert.rejects(
      createRepositorySeed(
        {
          async pushToken() {
            return "same-token";
          },
          async resolveRepository() {
            return {
              id: 42,
              name: "missing",
              fullName: "acme/missing",
              owner: "acme",
              url: `${server.url}/acme/missing`,
              cloneUrl: `${server.url}/acme/missing.git`,
              defaultBranch: "main",
              canClone: true,
            };
          },
        },
        "https://github.com/acme/missing",
        7,
        "main",
      ),
      (err: unknown) => isRepositoryAccessError(err),
    );
    assert.equal(requests, 1);
  } finally {
    await server.close();
  }
});

test("cloneUrlForSeed keeps a GitHub clone on github.com", () => {
  assert.equal(
    cloneUrlForSeed("https://github.com/danielpang/bento-cloud.git", "danielpang/bento-cloud"),
    "https://github.com/danielpang/bento-cloud.git",
  );
  assert.equal(
    cloneUrlForSeed("git@github.com:danielpang/bento-cloud.git", "danielpang/bento-cloud"),
    "https://github.com/danielpang/bento-cloud.git",
  );
  assert.throws(
    () => cloneUrlForSeed("https://example.com/danielpang/bento-cloud.git", "danielpang/bento-cloud"),
    /unexpected clone URL/,
  );
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
      fallbackToDefaultBranch: true,
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
    async pullRequestHasComment() {
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

/**
 * A plan stage commits only its write-up. With write-ups kept out of
 * the pull request, that branch is the base again, and pushing it would
 * open a pull request with no files changed on every new card.
 */
test("a branch that only changed stage notes opens no pull request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-publish-notes-"));
  await git(root, "init", "-b", "main");
  await writeFile(path.join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "base");

  const branch = "feature/plan-only";
  await git(root, "checkout", "-b", branch);
  await mkdir(path.join(root, "docs", "bento"), { recursive: true });
  await writeFile(path.join(root, "docs", "bento", "engineering-requirements.md"), "the plan\n");
  await git(root, "add", "docs");
  await git(root, "commit", "-m", "plan");

  const bare = await mkdtemp(path.join(tmpdir(), "bento-publish-notes-bare-"));
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "remote", "add", "origin", bare);
  await git(root, "push", "origin", "main");

  let opened = 0;
  const publisher = {
    async pushToken() {
      return "unused";
    },
    async ensurePullRequest() {
      opened += 1;
      return { prNumber: 4, url: "https://github.com/acme/app/pull/4" };
    },
    async getPullRequest() {
      return { title: "Plan only", body: null, state: "open", merged: false };
    },
    async updatePullRequest() {},
    async pullRequestHasComment() {
      return false;
    },
    async createPullRequestComment() {},
  };
  const db = {
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
  } as never;
  const plan = {
    featureId: "feature-id",
    featureTitle: "Plan only",
    branch,
    repositories: [
      { id: null, name: "app", repoUrl: "https://github.com/acme/app", defaultBranch: "main", worktreePath: root },
    ],
  };

  const notesOnly = await publishFeatureBranches(db, publisher, plan, { remoteUrl: () => bare });
  assert.deepEqual(notesOnly.failures, []);
  assert.deepEqual(notesOnly.published, []);
  assert.deepEqual(notesOnly.notesOnly, ["app"]);
  assert.equal(opened, 0, "no pull request is opened for a diff of nothing");
  const { stdout: remoteBranch } = await git(bare, "branch", "--list", branch);
  assert.equal(remoteBranch.trim(), "", "and nothing is pushed");

  // With the notes in the pull request, they are the change, so it opens.
  const withNotes = await publishFeatureBranches(db, publisher, plan, { remoteUrl: () => bare, includeStageNotes: true });
  assert.equal(withNotes.published.length, 1);
  assert.equal(opened, 1);

  // And once a stage commits code, the stripped branch has a diff again.
  await writeFile(path.join(root, "feature.txt"), "code\n");
  await git(root, "add", "feature.txt");
  await git(root, "commit", "-m", "code");
  const withCode = await publishFeatureBranches(db, publisher, plan, { remoteUrl: () => bare });
  assert.deepEqual(withCode.notesOnly, []);
  assert.equal(withCode.published.length, 1);
  assert.equal(opened, 2);
});
