import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { taskTrailer, type LandingPolicy } from "./branches.js";

const exec = promisify(execFile);

/**
 * Putting one worker's branch onto the swarm's branch.
 *
 * This is the whole of the dangerous part of a swarm, so it is its own
 * module with no database in it: everything here takes paths and branch
 * names and returns what happened, which is what lets it be driven
 * against real repositories in a test rather than against a stub that
 * always merges cleanly. A stub is never in conflict, and conflict is
 * the case that matters.
 *
 * Three rules shape it.
 *
 * The work happens in a checkout the server made and nothing else has
 * touched. Rebasing inside the worker's own sandbox would mean
 * resolving a conflict with the agent's hands on the tree, and
 * rebasing inside the swarm's would mean a failed landing leaving the
 * planner's checkout mid rebase. The temporary checkout is thrown away
 * either way, so a failure leaves nothing to clean up.
 *
 * The swarm's branch only ever moves forward, and only by fast
 * forward. The new head is built in the temporary checkout on top of
 * the swarm's current head, and then the swarm's own checkout is asked
 * to fast forward onto it. If the swarm's branch moved in between, the
 * fast forward fails and the landing is retried against the new head
 * rather than overwriting whatever moved it. That is the compare and
 * swap; there is no force push anywhere in this file.
 *
 * Nothing here runs the repository's own commands. The code being
 * landed was written by an agent, and running its test command on the
 * host would execute agent-authored code as the server. Tests run in
 * the swarm's sandbox, after the fast forward and before the landing
 * is called good; see landing.ts.
 */

export interface LandRequest {
  /**
   * The repository whose object store holds both branches.
   *
   * One store, because a worker's checkout is a worktree of the same
   * repository the swarm's is: that is what makes the worker's commits
   * reachable here without a bundle or a remote.
   */
  repoPath: string;
  /** The swarm's own checkout, which is where the fast forward happens. */
  swarmWorktree: string;
  swarmBranch: string;
  workerBranch: string;
  policy: LandingPolicy;
  /** The message a merge landing's own commit gets. */
  mergeMessage: string;
  /** Names this landing's temporary ref, so two cannot collide. */
  landingId: string;
}

export type LandOutcome =
  /** The swarm's branch now contains the worker's work. */
  | { ok: true; base: string; head: string; commits: number }
  /** The worker committed nothing. There is nothing to land and nothing wrong. */
  | { ok: false; reason: "empty" }
  /** Git could not reconcile the two. A resolver or a person decides. */
  | { ok: false; reason: "conflict"; detail: string }
  /** The swarm's branch moved while this was being built. Try again. */
  | { ok: false; reason: "moved"; detail: string }
  /** Anything else: a missing branch, a broken checkout, a full disk. */
  | { ok: false; reason: "error"; detail: string };

/** Where a landing parks the commit it built, until the fast forward takes it. */
function landingRef(landingId: string): string {
  return `refs/bento/landing/${landingId}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // A landing makes commits (a merge, or a rebase that has to
      // rewrite one), and git refuses to make any without an identity.
      // The server's, not the worker's: the authorship of the worker's
      // own commits is preserved by the rebase, and this only names
      // whoever performed the landing.
      GIT_AUTHOR_NAME: "Bento",
      GIT_AUTHOR_EMAIL: "bento@localhost",
      GIT_COMMITTER_NAME: "Bento",
      GIT_COMMITTER_EMAIL: "bento@localhost",
      // Nothing here should ever wait for a person: no editor, no
      // credential prompt, no pager.
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_PAGER: "cat",
    },
  });
  return stdout.trim();
}

function detailOf(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e?.stderr || e?.stdout || e?.message || String(err)).trim();
}

/**
 * Whether a failed rebase or merge failed because of a conflict, as
 * opposed to because something is broken.
 *
 * The distinction decides what happens next: a conflict starts a
 * resolver run, and an error fails the landing outright. Matched on
 * git's own words rather than on the exit code, because every one of
 * these exits non-zero.
 */
function isConflict(detail: string): boolean {
  return /conflict|could not apply|patch failed|fix conflicts|automatic merge failed/i.test(detail);
}

export async function landWorkerBranch(request: LandRequest): Promise<LandOutcome> {
  const { repoPath, swarmBranch, workerBranch } = request;
  let base: string;
  let workHead: string;
  try {
    base = await git(repoPath, ["rev-parse", `refs/heads/${swarmBranch}^{commit}`]);
    workHead = await git(repoPath, ["rev-parse", `refs/heads/${workerBranch}^{commit}`]);
  } catch (err) {
    return { ok: false, reason: "error", detail: detailOf(err) };
  }

  /**
   * Already there, which is the ordinary answer to running a landing
   * twice. A worker that committed nothing reads the same way, and both
   * are "nothing to do" rather than a failure: the job that crashed
   * after fast forwarding and before writing its row comes back through
   * here and is told the work is in.
   */
  if (workHead === base) return { ok: false, reason: "empty" };
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", workHead, base]);
    return { ok: true, base, head: base, commits: 0 };
  } catch {
    // Not an ancestor, which is the normal case: there is work to land.
  }

  /**
   * The swarm's checkout has to be on the swarm's branch, and this is
   * checked rather than assumed.
   *
   * `git merge --ff-only` in a checkout with a detached head succeeds:
   * it moves HEAD and leaves the branch exactly where it was. So a
   * landing into a detached swarm checkout reported success, wrote
   * "landed" on the row, and left the work nowhere, with the next
   * landing built on a branch that had never moved. The fast forward
   * is only a compare and swap on the branch while the checkout is
   * what holds the branch.
   */
  const checkedOut = await git(request.swarmWorktree, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  if (checkedOut !== swarmBranch) {
    return {
      ok: false,
      reason: "moved",
      detail: `the swarm's checkout is on ${checkedOut || "a detached head"} rather than ${swarmBranch}`,
    };
  }

  const root = await mkdtemp(path.join(tmpdir(), "bento-landing-"));
  const work = path.join(root, "checkout");
  try {
    await exec("git", ["init", "--quiet", work]);
    /**
     * Both branches fetched into this checkout under names of our own,
     * so nothing here depends on what the source repository calls its
     * HEAD or which of its branches happen to be checked out in a
     * worktree somewhere.
     */
    await git(work, [
      "fetch",
      "--no-tags",
      "--quiet",
      repoPath,
      `+refs/heads/${swarmBranch}:refs/heads/base`,
      `+refs/heads/${workerBranch}:refs/heads/work`,
    ]);
    await git(work, ["checkout", "--quiet", "base"]);

    if (request.policy === "merge") {
      await git(work, ["merge", "--no-ff", "-m", request.mergeMessage, "work"]);
    } else {
      /**
       * Rebase, so the swarm's branch stays linear and each of the
       * worker's commits arrives with its own message and its own
       * Bento-Task trailer. --keep-empty is deliberately absent: a
       * commit whose change is already on the swarm's branch is
       * dropped, which is what should happen to two leaves that made
       * the same small fix.
       */
      await git(work, ["checkout", "--quiet", "work"]);
      await git(work, ["rebase", "base"]);
      await git(work, ["checkout", "--quiet", "base"]);
      await git(work, ["merge", "--ff-only", "work"]);
    }

    const landed = await git(work, ["rev-parse", "HEAD"]);
    const countOut = await git(work, ["rev-list", "--count", `${base}..${landed}`]);
    const commits = Number(countOut) || 0;

    /**
     * The built commit is handed to the source repository under a ref
     * of this landing's own, rather than pushed at the swarm's branch.
     * Pushing at the branch would be refused anyway (it is checked out
     * in the swarm's worktree), and this way the objects are in place
     * before anything moves, so the fast forward below is a ref update
     * and not a transfer that could half succeed.
     */
    await git(work, ["push", "--quiet", repoPath, `HEAD:${landingRef(request.landingId)}`]);

    try {
      /**
       * The compare and swap. --ff-only is the whole of it: it succeeds
       * only if the swarm's branch is still the commit this landing was
       * built on, and fails if anything moved it, which is exactly the
       * race a second lander or a restarted job would be in. Done in
       * the swarm's own checkout so its working tree and its branch
       * move together; a bare update-ref would leave the planner's
       * checkout showing files that are no longer what the branch says.
       */
      await git(request.swarmWorktree, ["merge", "--ff-only", landed]);
    } catch (err) {
      const detail = detailOf(err);
      return { ok: false, reason: "moved", detail };
    } finally {
      await git(repoPath, ["update-ref", "-d", landingRef(request.landingId)]).catch(() => {});
    }

    return { ok: true, base, head: landed, commits };
  } catch (err) {
    const detail = detailOf(err);
    return isConflict(detail) ? { ok: false, reason: "conflict", detail } : { ok: false, reason: "error", detail };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The commits one task contributed, read back off a branch by trailer.
 *
 * By trailer rather than by a list of shas kept in a column, because a
 * rebase gives every commit a new sha and a stored list would be wrong
 * the moment the branch it describes was landed. The trailer travels
 * with the commit through both landing policies, which is the only
 * reason it exists.
 */
export async function commitsForTask(
  repoPath: string,
  branch: string,
  taskId: string,
  limit = 100,
): Promise<{ sha: string; subject: string; at: string }[]> {
  // A task id is a uuid, and a grep pattern built out of anything else
  // is a pattern somebody else wrote. Refused rather than escaped.
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return [];
  try {
    const out = await git(repoPath, [
      "log",
      `--max-count=${limit}`,
      // A record per commit, fields separated by a byte a commit
      // message cannot contain, so a subject with a newline or a pipe
      // in it cannot be read as two commits.
      "--format=%H%x1f%s%x1f%aI%x1e",
      "--fixed-strings",
      `--grep=${taskTrailer(taskId)}`,
      branch,
      "--",
    ]);
    if (!out) return [];
    return out
      .split("\u001e")
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.length > 0)
      .map((record) => {
        const [sha, subject, at] = record.split("\u001f");
        return sha && subject !== undefined && at ? { sha, subject, at } : null;
      })
      .filter((row): row is { sha: string; subject: string; at: string } => row !== null);
  } catch {
    return [];
  }
}
