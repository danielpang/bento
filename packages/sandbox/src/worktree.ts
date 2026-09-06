import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whether `worktree add` failed over a record left behind by a
 * worktree that is no longer on disk. Git says it two ways: the path
 * is registered, or the branch is claimed by whatever was registered
 * there.
 */
function isStaleRegistration(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message}${"stderr" in err ? String(err.stderr) : ""}` : String(err);
  return /missing but already registered worktree|already used by worktree/i.test(text);
}

/**
 * The ref a new branch starts at, given the branch the caller named.
 *
 * origin/<name> first: the base branch that matters is the one on
 * GitHub, which is where a merge lands, and a host checkout's own
 * <name> is only as fresh as the last fetch. Without a remote (a
 * repository added by path, never pushed anywhere) the local branch is
 * the best there is, and with neither the caller gets git's default of
 * wherever the checkout is standing.
 */
async function startPointIn(cwd: string, startFromBranch?: string): Promise<string | undefined> {
  if (!startFromBranch) return undefined;
  for (const ref of [`origin/${startFromBranch}`, startFromBranch]) {
    try {
      await run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      // Not in this checkout; try the next spelling.
    }
  }
  return undefined;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await run("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

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
  /**
   * The branch a branch created here starts from: origin/<name> when
   * the checkout has it, else <name>, else wherever the checkout is
   * standing.
   *
   * Left unset for an ordinary card, which branches from the checkout
   * the way it always has. Set when the caller means it, which today
   * is one case: a card whose pull request was merged starts its next
   * branch from the base branch, not from the merged one.
   */
  startFromBranch?: string;
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

  /**
   * Creates or reuses a worktree for every repository in the project.
   *
   * `branchChanged` is the caller saying the card is not on the branch
   * its workspace was built for, which today means its pull request
   * merged and it has started another. Only then is an existing
   * worktree moved: a worktree is where an agent has been working, and
   * a run that found one on a branch of the agent's own making left it
   * there before this and must keep doing so, or a card dies in
   * provisioning over an uncommitted file nobody asked about.
   */
  async ensureAll(
    repos: RepositorySpec[],
    featureId: string,
    branch: string,
    options: { branchChanged?: boolean } = {},
  ): Promise<PreparedRepository[]> {
    const workspace = this.workspacePath(featureId);
    await mkdir(workspace, { recursive: true });

    const prepared: PreparedRepository[] = [];
    for (const repo of repos) {
      const worktreePath = this.worktreePath(featureId, repo.name);
      await this.ensureOne(repo.localPath, worktreePath, branch, {
        startFromBranch: repo.startFromBranch,
        moveExisting: options.branchChanged === true,
      });
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

  private async ensureOne(
    repoPath: string,
    worktreePath: string,
    branch: string,
    options: { startFromBranch?: string | undefined; moveExisting: boolean },
  ): Promise<void> {
    const { startFromBranch } = options;
    // Existence must be checked on the filesystem, not via `git worktree
    // list`: git prints resolved paths (/private/var vs /var on macOS),
    // so string comparison misses live worktrees.
    if (await isDirectory(worktreePath)) {
      await run("git", ["-C", worktreePath, "rev-parse", "--git-dir"]);
      if (options.moveExisting) await this.switchBranch(worktreePath, branch, startFromBranch);
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
      await this.add(repoPath, [worktreePath, branch]);
    } else {
      // No branch of that name any more: the card's pull request was
      // merged and its branch deleted, or somebody tidied up. Starting
      // a fresh one is what a follow-up prompt wants, and is why the
      // add below is the -b form rather than a failure.
      const start = await startPointIn(repoPath, startFromBranch);
      await this.add(repoPath, ["-b", branch, worktreePath, ...(start ? [start] : [])]);
    }
  }

  /**
   * Puts an existing worktree on the branch this run works.
   *
   * A workspace is built once and reused for the life of the card, so
   * nothing else notices when the card's branch changes underneath it:
   * a card whose pull request was merged gets a new branch, and
   * without this its agent would go on committing to the merged one.
   *
   * The workspace itself is kept. Everything the card's toolchain
   * installed there is untracked, so it survives the checkout, and
   * throwing away a node_modules to change branch would cost more than
   * the change. Git refuses rather than overwrite an untracked file it
   * would have to replace, which is the one case worth stopping for.
   */
  private async switchBranch(worktreePath: string, branch: string, startFromBranch?: string): Promise<void> {
    const { stdout } = await run("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (stdout.trim() === branch) return;

    // -b only for a branch that is genuinely new. Resetting one that
    // already exists would move somebody's work to the start point.
    if (await branchExists(worktreePath, branch)) {
      await run("git", ["-C", worktreePath, "checkout", branch]);
      return;
    }
    const start = await startPointIn(worktreePath, startFromBranch);
    await run("git", ["-C", worktreePath, "checkout", "-b", branch, ...(start ? [start] : [])]);
  }

  /**
   * `git worktree add`, retried once after clearing leftover records.
   *
   * Git refuses a path, or a branch, that it still holds a record of,
   * even when the directory that record named is gone: "is a missing
   * but already registered worktree", or "is already used by worktree
   * at". Both outlive the directory, because BENTO_DATA_DIR defaults
   * under /var/tmp and macOS sweeps that out from under git. So a card
   * whose worktree had been swept failed every later prompt, and the
   * message named a directory the user could see was not there.
   *
   * `add` prunes on its own, but honours gc.worktreePruneExpire (three
   * months by default), so a record written this week is exactly the
   * one it leaves in place. `--expire=now` is what makes the retry
   * different from the attempt that just failed.
   *
   * Retried rather than pruned up front. Prune is repository wide
   * either way, and a worktree on a volume that happens to be
   * unmounted reads as missing to it, so what the retry buys is that
   * it never runs unless git has just said a leftover record is what
   * is in the way.
   */
  private async add(repoPath: string, args: string[]): Promise<void> {
    try {
      await run("git", ["-C", repoPath, "worktree", "add", ...args]);
    } catch (err) {
      if (!isStaleRegistration(err)) throw err;
      await run("git", ["-C", repoPath, "worktree", "prune", "--expire=now"]);
      await run("git", ["-C", repoPath, "worktree", "add", ...args]);
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
