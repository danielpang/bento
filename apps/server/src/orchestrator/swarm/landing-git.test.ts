import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { taskTrailer } from "./branches.js";
import { commitsForTask, isRetryableFastForward, landWorkerBranch } from "./landing-git.js";

const exec = promisify(execFile);

/**
 * Real repositories, real rebases, real conflicts.
 *
 * Landing is the one part of a swarm that can lose somebody's work, and
 * the failure it has to get right is the one a stub cannot produce: two
 * branches that touch the same lines. So every case here is a git
 * repository on disk with commits in it, and the assertions are what
 * `git log` says afterwards.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env: { ...process.env, ...IDENTITY } });
  return stdout.trim();
}

const TASK_A = "11111111-2222-3333-4444-555555555555";
const TASK_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface Fixture {
  root: string;
  repo: string;
  swarmWorktree: string;
}

/**
 * A repository with a swarm branch checked out in its own worktree, the
 * way a real swarm has one, plus whatever worker branches the test
 * needs. The worker's checkout is a worktree of the same repository,
 * which is what makes its commits reachable from the landing without a
 * remote.
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "bento-landtest-"));
  const repo = path.join(root, "repo");
  await exec("git", ["init", "--quiet", "-b", "main", repo]);
  await writeFile(path.join(repo, "shared.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(repo, "readme.md"), "start\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "--quiet", "-m", "base"]);

  await git(repo, ["branch", "swarm/demo"]);
  const swarmWorktree = path.join(root, "swarm");
  await git(repo, ["worktree", "add", "--quiet", swarmWorktree, "swarm/demo"]);
  return { root, repo, swarmWorktree };
}

/** A worker branch off the swarm branch, with one commit carrying its trailer. */
async function workerCommit(
  fx: Fixture,
  branch: string,
  taskId: string,
  file: string,
  contents: string,
  subject = `work on ${file}`,
): Promise<string> {
  const tree = path.join(fx.root, branch.replace(/\//g, "_"));
  const exists = await git(fx.repo, ["branch", "--list", branch]);
  if (!exists) await git(fx.repo, ["branch", branch, "swarm/demo"]);
  const added = await git(fx.repo, ["worktree", "list"]);
  if (!added.includes(tree)) await git(fx.repo, ["worktree", "add", "--quiet", tree, branch]);
  await writeFile(path.join(tree, file), contents);
  await git(tree, ["add", "."]);
  await git(tree, ["commit", "--quiet", "-m", `${subject}\n\n${taskTrailer(taskId)}`]);
  return git(tree, ["rev-parse", "HEAD"]);
}

describe("landing a worker's branch", () => {
  let fx: Fixture;
  before(async () => {
    fx = await fixture();
  });
  after(async () => {
    await rm(fx.root, { recursive: true, force: true });
  });

  test("a clean branch lands, and the swarm's checkout moves with its branch", async () => {
    await workerCommit(fx, "swarm/demo-aaaa1111", TASK_A, "a.txt", "from a\n");

    const before = await git(fx.swarmWorktree, ["rev-parse", "HEAD"]);
    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-aaaa1111",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-1",
    });

    assert.ok(result.ok, `expected a landing, got ${JSON.stringify(result)}`);
    assert.equal(result.base, before);
    assert.equal(result.commits, 1);

    // The branch moved, and so did the files in the checkout: a ref
    // that moved without its working tree would leave the planner
    // looking at code the branch no longer has.
    assert.equal(await git(fx.swarmWorktree, ["rev-parse", "HEAD"]), result.head);
    assert.equal(await git(fx.swarmWorktree, ["rev-parse", "swarm/demo"]), result.head);
    assert.equal(await git(fx.swarmWorktree, ["show", "HEAD:a.txt"]), "from a");
    assert.equal(await git(fx.swarmWorktree, ["status", "--porcelain"]), "", "the checkout is clean afterwards");
  });

  test("a second, non-overlapping branch lands on top of the first", async () => {
    await workerCommit(fx, "swarm/demo-bbbb2222", TASK_B, "b.txt", "from b\n");

    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-bbbb2222",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-2",
    });
    assert.ok(result.ok, `expected a landing, got ${JSON.stringify(result)}`);

    // Both leaves' files are present, which is the point of a queue
    // rather than of each worker pushing its own branch.
    assert.equal(await git(fx.swarmWorktree, ["show", "HEAD:a.txt"]), "from a");
    assert.equal(await git(fx.swarmWorktree, ["show", "HEAD:b.txt"]), "from b");
  });

  test("the trailer is what attributes commits after a rebase has changed their shas", async () => {
    const commits = await commitsForTask(fx.repo, "swarm/demo", TASK_A);
    assert.equal(commits.length, 1);
    assert.match(commits[0]!.subject, /work on a\.txt/);

    // The sha on the swarm's branch is not the sha the worker made:
    // that is exactly why a stored list of shas could not do this job.
    const onBranch = commits[0]!.sha;
    const others = await commitsForTask(fx.repo, "swarm/demo", TASK_B);
    assert.equal(others.length, 1);
    assert.notEqual(others[0]!.sha, onBranch);

    assert.deepEqual(await commitsForTask(fx.repo, "swarm/demo", "00000000-0000-0000-0000-000000000000"), []);
  });

  test("landing the same branch twice is not an error and does not duplicate the work", async () => {
    const head = await git(fx.swarmWorktree, ["rev-parse", "HEAD"]);
    const again = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-aaaa1111",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-1",
    });
    assert.ok(again.ok, "work already on the branch reads as landed, which is what a retried job needs");
    assert.equal(again.commits, 0);
    assert.equal(await git(fx.swarmWorktree, ["rev-parse", "HEAD"]), head, "nothing moved");
  });

  test("a worker that committed nothing is empty rather than a failure", async () => {
    await git(fx.repo, ["branch", "swarm/demo-empty000", "swarm/demo"]);
    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-empty000",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-3",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "empty");
  });

  test("two leaves editing the same lines conflict, and the swarm's branch does not move", async () => {
    // Both branch off the same swarm head and rewrite the same file, so
    // whichever lands second cannot be replayed onto the first.
    await workerCommit(fx, "swarm/demo-cccc3333", TASK_A, "shared.txt", "one\nCHANGED BY C\nthree\n", "c edits shared");
    await workerCommit(fx, "swarm/demo-dddd4444", TASK_B, "shared.txt", "one\nCHANGED BY D\nthree\n", "d edits shared");

    const first = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-cccc3333",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-4",
    });
    assert.ok(first.ok, "the first of the two lands normally");
    const afterFirst = await git(fx.swarmWorktree, ["rev-parse", "HEAD"]);

    const second = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-dddd4444",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-5",
    });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, "conflict");

    // The whole reason the work happens in a throwaway checkout: a
    // conflict leaves the swarm exactly where it was, with no rebase in
    // progress and nothing half applied.
    assert.equal(await git(fx.swarmWorktree, ["rev-parse", "HEAD"]), afterFirst);
    assert.equal(await git(fx.swarmWorktree, ["status", "--porcelain"]), "");
    assert.equal(await git(fx.swarmWorktree, ["show", "HEAD:shared.txt"]), "one\nCHANGED BY C\nthree");
  });

  test("a conflicted branch lands once a resolver has merged the swarm's branch into it", async () => {
    // What a resolver run does: it works in its own checkout of the
    // leaf's branch, merges the swarm's branch in, and resolves. The
    // landing that follows is a merge rather than a rebase, because the
    // branch now already contains the swarm's head.
    const tree = path.join(fx.root, "swarm_demo-dddd4444");
    await git(tree, ["merge", "--no-commit", "swarm/demo"]).catch(() => {});
    await writeFile(path.join(tree, "shared.txt"), "one\nCHANGED BY C AND D\nthree\n");
    await git(tree, ["add", "."]);
    await git(tree, ["commit", "--quiet", "-m", `resolve\n\n${taskTrailer(TASK_B)}`]);

    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-dddd4444",
      policy: "merge",
      mergeMessage: `Land: d edits shared\n\n${taskTrailer(TASK_B)}`,
      landingId: "landing-6",
    });
    assert.ok(result.ok, `expected the resolved branch to land, got ${JSON.stringify(result)}`);
    assert.equal(await git(fx.swarmWorktree, ["show", "HEAD:shared.txt"]), "one\nCHANGED BY C AND D\nthree");

    // The merge commit carries the trailer, so the console can still
    // attribute the landing to the leaf that caused it.
    const commits = await commitsForTask(fx.repo, "swarm/demo", TASK_B);
    assert.ok(commits.length >= 1);
  });

  test("a detached swarm checkout is an error, because no retry ever attaches it", async () => {
    /**
     * `git merge --ff-only` in a detached checkout succeeds and moves
     * nothing but HEAD, so this is checked before anything is built.
     *
     * An error rather than something to try again, and that is the
     * whole of this test. Nothing in a swarm ever puts that checkout
     * back onto its branch, so a landing told to retry here retries for
     * ever: a tick, a land job and a handful of git subprocesses per
     * pass, against a condition that cannot change on its own.
     */
    await workerCommit(fx, "swarm/demo-eeee5555", TASK_A, "e.txt", "from e\n");
    const moved = path.join(fx.root, "mover");
    await git(fx.repo, ["worktree", "add", "--quiet", "--detach", moved, "swarm/demo"]);

    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: moved,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-eeee5555",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-7",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "error");
    assert.match(result.ok === false ? result.detail : "", /detached head/);
    assert.equal(
      await git(fx.repo, ["rev-parse", "swarm/demo"]),
      await git(fx.swarmWorktree, ["rev-parse", "HEAD"]),
      "the branch is where the swarm's own checkout left it",
    );
  });

  test("a swarm checkout with uncommitted changes is an error, not a retry", async () => {
    /**
     * The case that made the requeue loop real.
     *
     * The planner's sandbox mounts the swarm's own checkout, and a
     * landing runs each repository's test command in it, so a file left
     * modified there is ordinary rather than exotic. Git refuses the
     * fast forward with words that match no conflict pattern, which the
     * catch around it used to answer with "the branch moved": the row
     * went back to the queue, the next tick promoted it, and it said
     * the same thing again, for as long as the file stayed dirty.
     */
    await workerCommit(fx, "swarm/demo-ffff6666", TASK_A, "shared.txt", "one\nFROM F\nthree\n", "f edits shared");
    const head = await git(fx.swarmWorktree, ["rev-parse", "HEAD"]);
    await writeFile(path.join(fx.swarmWorktree, "shared.txt"), "one\nLEFT BEHIND BY A TEST RUN\nthree\n");

    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-ffff6666",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-9",
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false && result.reason,
      "error",
      "git said the local changes would be overwritten, which no number of retries gets past",
    );
    assert.match(result.ok === false ? result.detail : "", /local changes/i);
    assert.equal(await git(fx.swarmWorktree, ["rev-parse", "HEAD"]), head, "and the branch did not move");

    await git(fx.swarmWorktree, ["checkout", "--", "shared.txt"]);
  });

  test("a locked swarm checkout is worth trying again", async () => {
    /**
     * The other half of the classification: a git process in the
     * swarm's sandbox holding the index lock is exactly the failure a
     * retry is for, and it has to stay retryable now that the dirty
     * case does not.
     */
    await workerCommit(fx, "swarm/demo-ffff6666", TASK_A, "g.txt", "from g\n", "g adds a file");
    const gitDir = await git(fx.swarmWorktree, ["rev-parse", "--absolute-git-dir"]);
    const lock = path.join(gitDir, "index.lock");
    await writeFile(lock, "");
    try {
      const result = await landWorkerBranch({
        repoPath: fx.repo,
        swarmWorktree: fx.swarmWorktree,
        swarmBranch: "swarm/demo",
        workerBranch: "swarm/demo-ffff6666",
        policy: "rebase",
        mergeMessage: "unused",
        landingId: "landing-10",
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "moved", "somebody else is holding the checkout for a moment");
    } finally {
      await rm(lock, { force: true });
    }
  });

  test("the classification is git's own words, not a guess about them", () => {
    // Collected from git itself, which is the only place these strings
    // are defined; a stub would have whatever wording we imagined.
    assert.equal(isRetryableFastForward("fatal: Not possible to fast-forward, aborting."), true);
    assert.equal(isRetryableFastForward("hint: Diverging branches can't be fast-forwarded"), true);
    assert.equal(
      isRetryableFastForward("error: Unable to create '/repo/.git/worktrees/sw/index.lock': File exists."),
      true,
    );
    assert.equal(
      isRetryableFastForward(
        "error: Your local changes to the following files would be overwritten by merge:\n\tshared.txt",
      ),
      false,
    );
    assert.equal(
      isRetryableFastForward("error: Untracked working tree file 'a.txt' would be overwritten by merge."),
      false,
    );
    assert.equal(isRetryableFastForward("fatal: not a git repository"), false);
  });

  test("a branch that is not there is an error, not a conflict", async () => {
    const result = await landWorkerBranch({
      repoPath: fx.repo,
      swarmWorktree: fx.swarmWorktree,
      swarmBranch: "swarm/demo",
      workerBranch: "swarm/demo-nosuch00",
      policy: "rebase",
      mergeMessage: "unused",
      landingId: "landing-8",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "error");
  });
});
