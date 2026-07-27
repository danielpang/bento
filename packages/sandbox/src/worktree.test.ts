import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorktreeManager } from "./worktree.js";

const run = promisify(execFile);

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-worktree-repo-"));
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
