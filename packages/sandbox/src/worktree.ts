import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export interface RepositorySpec {
  /** Directory name inside the workspace. */
  name: string;
  /** Path to the repository on the host. */
  localPath: string;
}

export interface PreparedRepository extends RepositorySpec {
  /** Host path of this repository's worktree. */
  worktreePath: string;
}

/**
 * Where a repository appears inside a sandbox. Derived from the
 * sandbox's own workdir rather than assumed, because the local process
 * driver's workspace is a host path while a container's is /workspace.
 */
export function repositoryPathIn(sandboxWorkdir: string, repoName: string): string {
  return `${sandboxWorkdir.replace(/\/$/, "")}/${repoName}`;
}

/**
 * Manages per-feature git worktrees on the host.
 *
 * A feature gets one workspace directory containing a worktree per
 * repository in its project:
 *
 *   <dataDir>/worktrees/<featureId>/<repoName>
 *
 * The workspace directory is what gets mounted into the sandbox, so a
 * feature spanning several repositories sees /workspace/api and
 * /workspace/web side by side. Single repository projects get the same
 * shape, which keeps prompts and paths uniform.
 */
export class WorktreeManager {
  constructor(private dataDir: string) {}

  /** Host directory mounted into the sandbox as /workspace. */
  workspacePath(featureId: string): string {
    return path.join(this.dataDir, "worktrees", featureId);
  }

  worktreePath(featureId: string, repoName: string): string {
    return path.join(this.workspacePath(featureId), repoName);
  }

  /** Creates or reuses a worktree for every repository in the project. */
  async ensureAll(repos: RepositorySpec[], featureId: string, branch: string): Promise<PreparedRepository[]> {
    const workspace = this.workspacePath(featureId);
    await mkdir(workspace, { recursive: true });

    const prepared: PreparedRepository[] = [];
    for (const repo of repos) {
      const worktreePath = this.worktreePath(featureId, repo.name);
      await this.ensureOne(repo.localPath, worktreePath, branch);
      prepared.push({ ...repo, worktreePath });
    }
    await this.pruneOrphans(workspace, new Set(repos.map((r) => r.name)));
    return prepared;
  }

  /**
   * Drops worktrees for repositories the project no longer spans.
   *
   * A workspace is built once and reused for the life of the feature,
   * so without this a repository stays mounted after it is removed from
   * the project, and every later agent can still read and write it.
   * Removing a repository has to actually take it away.
   *
   * Only git worktrees are considered. A workspace also holds whatever
   * the agents left behind, which is not ours to delete, and anything
   * git declines to disown is left where it is.
   */
  private async pruneOrphans(workspace: string, keep: Set<string>): Promise<void> {
    let entries;
    try {
      entries = await readdir(workspace, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      const candidate = path.join(workspace, entry.name);

      // The owning repository is read out of the worktree itself: an
      // orphan has no row left to look its source path up from.
      let mainRepo: string;
      try {
        const { stdout } = await run("git", [
          "-C",
          candidate,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        mainRepo = path.dirname(stdout.trim());
      } catch {
        continue;
      }

      try {
        await run("git", ["-C", mainRepo, "worktree", "remove", "--force", candidate]);
      } catch {
        // Not a worktree of that repository, so not one of ours to take.
      }
    }
  }

  private async ensureOne(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    // Existence must be checked on the filesystem, not via `git worktree
    // list`: git prints resolved paths (/private/var vs /var on macOS),
    // so string comparison misses live worktrees.
    if (await isDirectory(worktreePath)) {
      await run("git", ["-C", worktreePath, "rev-parse", "--git-dir"]);
      return;
    }

    // Said outright rather than left to git's "cannot change to"
    // fatal: the usual cause is a server running somewhere the checkout
    // is not, such as a container without the repository mounted.
    if (!(await isDirectory(repoPath))) {
      throw new Error(
        `repository path ${repoPath} does not exist on the machine running the server. ` +
          `If the server runs in a container, mount the checkout at the same path.`,
      );
    }

    const branches = await run("git", ["-C", repoPath, "branch", "--list", branch]);
    if (branches.stdout.trim()) {
      await this.reclaimStaleCheckout(repoPath, worktreePath, branch);
      await run("git", ["-C", repoPath, "worktree", "add", worktreePath, branch]);
    } else {
      await run("git", ["-C", repoPath, "worktree", "add", "-b", branch, worktreePath]);
    }
  }

  /**
   * A branch can be checked out in only one worktree, and the old one
   * survives a change of data directory (moving between `bento` and the
   * container stack changes BENTO_DATA_DIR). A clean or unreachable
   * leftover is removed so the branch can be checked out here; one with
   * uncommitted changes is refused by name, because deleting it would
   * discard work.
   */
  private async reclaimStaleCheckout(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    const { stdout } = await run("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
    let current: string | null = null;
    let stale: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}` && current && path.resolve(current) !== path.resolve(worktreePath)) {
        stale = current;
      }
    }
    if (!stale) return;

    // Unreachable from this process (an old data directory this server
    // has no view of) reads as absent; removing the metadata leaves any
    // files where they are without deleting anything.
    if (await isDirectory(stale)) {
      const status = await run("git", ["-C", stale, "status", "--porcelain"]);
      if (status.stdout.trim()) {
        throw new Error(
          `branch ${branch} is checked out at ${stale} with uncommitted changes. ` +
            `Commit or discard them, or remove that worktree, then run again.`,
        );
      }
    }
    await run("git", ["-C", repoPath, "worktree", "remove", "--force", stale]).catch(async () => {
      // remove refuses paths it cannot stat; prune clears the record.
      await run("git", ["-C", repoPath, "worktree", "prune"]);
    });
  }

  async remove(repoPath: string, featureId: string, repoName: string): Promise<void> {
    try {
      await run("git", ["-C", repoPath, "worktree", "remove", "--force", this.worktreePath(featureId, repoName)]);
    } catch {
      // Already gone or never created.
    }
  }
}
