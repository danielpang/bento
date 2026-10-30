import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { WorktreeManager } from "@bento/sandbox";
import { swarmWorkspaceKey } from "./sandbox.js";

const run = promisify(execFile);

type Repo = { name: string; localPath: string };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/** The worktree holding a branch, if Git still has one registered. */
export async function branchCheckoutPath(repoPath: string, branch: string): Promise<string | null> {
  const list = await git(repoPath, "worktree", "list", "--porcelain");
  for (const entry of list.split(/\n\s*\n/)) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null;
    }
  }
  return null;
}

/**
 * Release only the swarm's clean checkout. Git keeps the branch and all
 * commits. Preflight every repository before removing any worktree so a
 * dirty second repository cannot leave a multi-repo project half freed.
 */
export async function releaseSwarmBranch(
  worktrees: WorktreeManager,
  swarmId: string,
  branch: string,
  repos: Repo[],
): Promise<void> {
  const paths: { repo: Repo; worktree: string }[] = [];
  for (const repo of repos) {
    const worktree = worktrees.worktreePath(swarmWorkspaceKey(swarmId), repo.name);
    if (!(await stat(worktree).then((entry) => entry.isDirectory(), () => false))) {
      // A previous attempt may have removed one repository before a
      // later removal failed. A retry can finish the remaining ones.
      await git(repo.localPath, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
      const checkout = await branchCheckoutPath(repo.localPath, branch);
      if (checkout) {
        throw new Error(`The branch for ${repo.name} is still checked out at ${checkout}. The branch was not released.`);
      }
      continue;
    }
    const current = await git(worktree, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (current !== branch) {
      throw new Error(`Bento's checkout for ${repo.name} is on ${current}, not ${branch}. The branch was not released.`);
    }
    if (await git(worktree, "status", "--porcelain=v1", "--untracked-files=all")) {
      throw new Error(`Bento's checkout for ${repo.name} has uncommitted files. Commit or remove them before releasing the branch.`);
    }
    await git(repo.localPath, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
    paths.push({ repo, worktree });
  }

  for (const { repo, worktree } of paths) {
    await git(repo.localPath, "worktree", "unlock", worktree);
    try {
      // No --force: Git must refuse if anything changed since preflight.
      await git(repo.localPath, "worktree", "remove", worktree);
    } catch (error) {
      await git(repo.localPath, "worktree", "lock", "--reason", "Bento workspace", worktree).catch(() => {});
      throw error;
    }
  }
}

/**
 * Why removing a host checkout would lose work, or null when it would
 * not.
 *
 * A Docker or local machine works in a worktree of the project's own
 * repository, so its commits are the repository's: removing the
 * worktree keeps every branch. What it does not keep is a file nobody
 * committed, or a commit no local branch reaches (a detached HEAD), and
 * `git worktree remove --force` deletes both without a word. A checkout
 * that cannot be read is answered as unsaved, because the safe mistake
 * is keeping a directory.
 */
export async function hostCheckoutUnsaved(worktree: string, repoPath: string, repoName: string): Promise<string | null> {
  if (!(await stat(worktree).then((entry) => entry.isDirectory(), () => false))) return null;
  try {
    if (await git(worktree, "status", "--porcelain=v1", "--untracked-files=all")) {
      return `${repoName} has uncommitted files`;
    }
    const head = await git(worktree, "rev-parse", "--verify", "HEAD^{commit}");
    const branches = await git(repoPath, "for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads/");
    if (!branches) return `${repoName}'s last commit is on no branch of ${repoPath}`;
    return null;
  } catch (error) {
    return `${repoName}'s checkout could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
}
