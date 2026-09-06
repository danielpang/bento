import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorktreeManager } from "./worktree.js";

const run = promisify(execFile);

/**
 * A temporary directory git and node agree on the spelling of.
 * /var/folders and /var/tmp are symlinks on macOS, and git stores the
 * path it resolved: a fixture that skipped this would compare
 * /var/... against /private/var/... and take the "different path"
 * branch of every check under test.
 */
async function scratchDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

async function fixtureRepo(): Promise<string> {
  const dir = await scratchDir("bento-worktree-repo-");
  await run("git", ["-C", dir, "init", "-qb", "main"]);
  await writeFile(path.join(dir, "README.md"), "fixture\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "init"]);
  return dir;
}

/**
 * Moving between `bento` and the container stack changes the data
 * directory, and the old one keeps the branch checked out. Git allows a
 * branch in one worktree only, so provisioning has to reclaim the
 * leftover rather than die on it.
 */
test("a clean worktree from an old data directory is reclaimed", async () => {
  const repo = await fixtureRepo();
  const branch = "feature/reclaim-me";

  const oldDataDir = await mkdtemp(path.join(tmpdir(), "bento-old-data-"));
  const before = new WorktreeManager(oldDataDir);
  await before.ensureAll([{ name: "app", localPath: repo }], "feat-1", branch);

  const newDataDir = await mkdtemp(path.join(tmpdir(), "bento-new-data-"));
  const after = new WorktreeManager(newDataDir);
  const prepared = await after.ensureAll([{ name: "app", localPath: repo }], "feat-1", branch);

  assert.equal(prepared[0]!.worktreePath, path.join(newDataDir, "worktrees", "feat-1", "app"));
  const { stdout } = await run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  const homes = stdout.split("\n").filter((l) => l.includes(`refs/heads/${branch}`));
  assert.equal(homes.length, 1, "the branch lives in exactly one worktree again");
});

test("a dirty leftover worktree is refused by name, not deleted", async () => {
  const repo = await fixtureRepo();
  const branch = "feature/dirty-hands";

  const oldDataDir = await mkdtemp(path.join(tmpdir(), "bento-old-data-"));
  const before = new WorktreeManager(oldDataDir);
  const [old] = await before.ensureAll([{ name: "app", localPath: repo }], "feat-2", branch);
  await writeFile(path.join(old!.worktreePath, "WIP.md"), "uncommitted\n");

  const after = new WorktreeManager(await mkdtemp(path.join(tmpdir(), "bento-new-data-")));
  await assert.rejects(
    after.ensureAll([{ name: "app", localPath: repo }], "feat-2", branch),
    /uncommitted changes/,
    "work in the old worktree must not be silently discarded",
  );
});

/**
 * BENTO_DATA_DIR defaults under /var/tmp, which macOS sweeps. The
 * directory goes; git's record of it does not, and every later prompt
 * on that card died on "is a missing but already registered worktree".
 */
test("a worktree whose directory was swept away is recreated", async () => {
  const repo = await fixtureRepo();
  const branch = "feature/swept-away";

  const dataDir = await scratchDir("bento-swept-data-");
  const manager = new WorktreeManager(dataDir);
  const [first] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-3", branch);
  await rm(first!.worktreePath, { recursive: true, force: true });

  const [again] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-3", branch);
  assert.equal(again!.worktreePath, first!.worktreePath);
  const { stdout } = await run("git", ["-C", again!.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), branch, "the card is back on its own branch");
});

/**
 * A merged pull request takes the branch with it, and someone tidying
 * up locally takes the local one. The card is still on the board, so
 * the next prompt starts a fresh branch rather than failing.
 */
test("a card whose branch is gone starts a new one", async () => {
  const repo = await fixtureRepo();
  const branch = "feature/merged-and-deleted";

  const dataDir = await scratchDir("bento-merged-data-");
  const manager = new WorktreeManager(dataDir);
  const [first] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-4", branch);
  await rm(first!.worktreePath, { recursive: true, force: true });
  await run("git", ["-C", repo, "worktree", "prune", "--expire=now"]);
  await run("git", ["-C", repo, "branch", "-D", branch]);

  const [again] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-4", branch);
  const { stdout } = await run("git", ["-C", again!.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), branch, "a new branch of the same name carries the follow-up work");
});

/**
 * A card whose pull request merged gets a new branch, and its
 * workspace already exists from the run that opened that pull request.
 * The new branch has to start where the merge landed, and the checkout
 * has to actually move to it.
 */
test("a card's new branch starts from the base branch and the worktree follows", async () => {
  const repo = await fixtureRepo();
  const origin = await scratchDir("bento-origin-");
  await run("git", ["-C", origin, "init", "-q", "--bare", "-b", "main"]);
  await run("git", ["-C", repo, "remote", "add", "origin", origin]);
  await run("git", ["-C", repo, "push", "-q", "origin", "main"]);

  const dataDir = await scratchDir("bento-rotate-data-");
  const manager = new WorktreeManager(dataDir);
  const [worked] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-5", "feature/landed");
  await writeFile(path.join(worked!.worktreePath, "card.md"), "the card's work\n");
  await run("git", ["-C", worked!.worktreePath, "add", "-A"]);
  await run("git", [
    "-C", worked!.worktreePath,
    "-c", "user.email=t@t.test", "-c", "user.name=t",
    "commit", "-qm", "card work",
  ]);

  // The pull request merges, and main moves on without this checkout.
  const clone = await scratchDir("bento-merger-");
  await run("git", ["-C", clone, "clone", "-q", origin, "."]);
  await writeFile(path.join(clone, "merged.md"), "landed\n");
  await run("git", ["-C", clone, "add", "-A"]);
  await run("git", ["-C", clone, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "merge"]);
  await run("git", ["-C", clone, "push", "-q", "origin", "main"]);
  await run("git", ["-C", repo, "fetch", "-q", "origin", "main"]);
  const { stdout: landed } = await run("git", ["-C", repo, "rev-parse", "origin/main"]);

  const [next] = await manager.ensureAll(
    [{ name: "app", localPath: repo, startFromBranch: "main" }],
    "feat-5",
    "feature/landed-2",
    { branchChanged: true },
  );

  assert.equal(next!.worktreePath, worked!.worktreePath, "the workspace is reused, not rebuilt");
  const { stdout: head } = await run("git", ["-C", next!.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.trim(), "feature/landed-2");
  const { stdout: at } = await run("git", ["-C", next!.worktreePath, "rev-parse", "HEAD"]);
  assert.equal(at.trim(), landed.trim(), "the new branch starts at the merge, not at the branch that merged");
});

/**
 * Only a rotated branch starts from the base branch. An ordinary card
 * branches from the checkout, which is where every card before this
 * change started, and where somebody working on a stacked branch means
 * it to start.
 */
test("without a base branch a card still branches from the checkout", async () => {
  const repo = await fixtureRepo();
  await run("git", ["-C", repo, "checkout", "-qb", "stacked"]);
  await writeFile(path.join(repo, "stacked.md"), "unmerged work\n");
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, "-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-qm", "stacked"]);
  const { stdout: tip } = await run("git", ["-C", repo, "rev-parse", "HEAD"]);

  const manager = new WorktreeManager(await scratchDir("bento-stacked-data-"));
  const [prepared] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-6", "feature/on-top");

  const { stdout: at } = await run("git", ["-C", prepared!.worktreePath, "rev-parse", "HEAD"]);
  assert.equal(at.trim(), tip.trim());
});

/**
 * A repository the card never landed anything in still holds commits,
 * and its new branch has to carry them: it starts where its old branch
 * stood, not at a base branch that has never seen them. This is the
 * other repository of a card whose publish only succeeded in one.
 */
test("a repository with nothing merged carries its commits onto the new branch", async () => {
  const repo = await fixtureRepo();
  const manager = new WorktreeManager(await scratchDir("bento-unmerged-data-"));
  const [worked] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-7", "feature/two-repos");
  await writeFile(path.join(worked!.worktreePath, "unpublished.md"), "never opened a pull request\n");
  await run("git", ["-C", worked!.worktreePath, "add", "-A"]);
  await run("git", [
    "-C", worked!.worktreePath,
    "-c", "user.email=t@t.test", "-c", "user.name=t",
    "commit", "-qm", "work nobody published",
  ]);
  const { stdout: before } = await run("git", ["-C", worked!.worktreePath, "rev-parse", "HEAD"]);

  // The card rotates because the other repository's pull request
  // merged. This one is told to move, but not where to start.
  const [next] = await manager.ensureAll(
    [{ name: "app", localPath: repo }],
    "feat-7",
    "feature/two-repos-2",
    { branchChanged: true },
  );

  const { stdout: head } = await run("git", ["-C", next!.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.trim(), "feature/two-repos-2");
  const { stdout: at } = await run("git", ["-C", next!.worktreePath, "rev-parse", "HEAD"]);
  assert.equal(at.trim(), before.trim(), "the unpublished commit came with the card");
});

/**
 * Agents check out branches of their own. A run that found a worktree
 * somewhere unexpected left it there before rotation existed, and has
 * to keep doing so: moving it would fail the run over an uncommitted
 * file, or walk away from a commit nobody has published.
 */
test("an ordinary run leaves a worktree on whatever branch it found", async () => {
  const repo = await fixtureRepo();
  const manager = new WorktreeManager(await scratchDir("bento-drifted-data-"));
  const [worked] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-8", "feature/agent-wandered");
  await run("git", ["-C", worked!.worktreePath, "checkout", "-qb", "agent/side-quest"]);
  await writeFile(path.join(worked!.worktreePath, "scratch.txt"), "uncommitted\n");

  const [again] = await manager.ensureAll([{ name: "app", localPath: repo }], "feat-8", "feature/agent-wandered");

  const { stdout } = await run("git", ["-C", again!.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(stdout.trim(), "agent/side-quest", "the run works where the agent was, as it always has");
});
