import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { repositories, type Db } from "@bento/db";
import { parseRepoUrl } from "@bento/github";

const run = promisify(execFile);

/**
 * The GitHub remote a checkout already has.
 *
 * A repository added by path arrives with no URL: the person pointed at
 * a directory, and nothing asked them for a remote. Their checkout knows
 * it, so read it rather than making them restate what git recorded when
 * they cloned. Without this, pull requests refused with "no GitHub
 * remote is linked" on repositories whose origin was GitHub all along.
 *
 * Read from the path on the repository row, never from a feature
 * worktree: a worktree is what an agent has been writing in, so its
 * origin is a URL an agent can choose, and a push credential must not
 * follow one of those.
 *
 * Returns the canonical https form, or null when there is no GitHub
 * remote to find, which includes every case where the path is not a
 * readable git repository on this machine.
 */
export async function githubRemoteOf(localPath: string): Promise<string | null> {
  for (const name of await remoteNames(localPath)) {
    try {
      const { stdout } = await run("git", ["-C", localPath, "remote", "get-url", name], { env: gitEnv() });
      const parsed = parseRepoUrl(stdout.trim());
      // Canonical https, whatever the checkout uses: ssh and https forms
      // of the same repository must not become two different rows, and
      // publishing pushes over https with a token either way.
      if (parsed) return `https://github.com/${parsed.owner}/${parsed.repo}`;
    } catch {
      // A remote listed but unreadable is simply not the one.
    }
  }
  return null;
}

/** Remotes of the checkout, origin first, because origin is the one people mean. */
async function remoteNames(localPath: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["-C", localPath, "remote"], { env: gitEnv() });
    const names = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return names.sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * The branch a checkout's work starts from, read from the checkout.
 *
 * Every repository used to be recorded against `main` unless the caller
 * said otherwise, and nothing asked. A repository whose trunk is
 * `master` then failed its first provision with "Could not refresh
 * origin/main", half an hour after the person who added it had moved on.
 *
 * Asks in the order git itself would answer: what origin says its HEAD
 * is, then whichever of the two conventional names exists, then the
 * branch the checkout is on. Null when none of that is readable, which
 * includes a path that is not a git repository on this machine.
 */
export async function detectDefaultBranch(localPath: string): Promise<string | null> {
  const originHead = await gitOutput(localPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead?.startsWith("origin/")) return originHead.slice("origin/".length);
  for (const candidate of ["main", "master"]) {
    if (await branchExists(localPath, candidate)) return candidate;
  }
  return await gitOutput(localPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

/**
 * Whether the checkout has the branch locally or as origin's. Nothing is
 * fetched: a person typing a name wants an answer now, and one that
 * exists only on a remote this checkout never fetched is worth a word
 * before the first run rather than after it.
 */
export async function branchExists(localPath: string, branch: string): Promise<boolean> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if ((await gitOutput(localPath, ["rev-parse", "--verify", "--quiet", ref])) !== null) return true;
  }
  return false;
}

async function gitOutput(localPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", localPath, ...args], { env: gitEnv() });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Nothing here talks to a remote, but a git that decides to ask for a
 * password would hang the request rather than fail it.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Best-effort refresh of origin/<base> in host checkouts, before a
 * conflict-resolution run on a worktree driver.
 *
 * Sprites re-seed the base branch on every provision, but the docker
 * and local drivers share the host repository's .git, whose
 * origin/<base> is only as fresh as the last time somebody fetched.
 * The agent is told to fetch too; this covers the sandbox that cannot
 * (no credentials, restricted network) by fetching on the trusted
 * host, where the operator's own git configuration answers. Failures
 * are swallowed: a repository that cannot be fetched here could not be
 * fetched by the run either, and the prompt tells the agent to say so.
 */
export async function refreshBaseBranches(
  repos: { localPath: string; defaultBranch: string }[],
): Promise<void> {
  for (const repo of repos) {
    try {
      await run("git", ["-C", repo.localPath, "fetch", "origin", repo.defaultBranch], {
        env: gitEnv(),
        timeout: 30_000,
      });
    } catch {
      // Stale is survivable; hanging the button press is not.
    }
  }
}

interface LinkableRepository {
  id: string;
  localPath: string;
  repoUrl: string | null;
  githubRepoId: string | null;
}

/**
 * Fills in the remote for repositories added before their URL was read,
 * and remembers it.
 *
 * Persisted rather than resolved per publish so the rest of the system
 * (gate criteria that read pull requests, the seeds a hosted sandbox
 * clones) sees the same link, and so the answer does not change if the
 * checkout later moves. Rows that already carry a URL are left alone.
 */
export async function linkGitHubRemotes<T extends LinkableRepository>(db: Db, rows: T[]): Promise<T[]> {
  const linked: T[] = [];
  for (const row of rows) {
    if (row.repoUrl || row.githubRepoId) {
      linked.push(row);
      continue;
    }
    const repoUrl = await githubRemoteOf(row.localPath);
    if (!repoUrl) {
      linked.push(row);
      continue;
    }
    await db.update(repositories).set({ repoUrl }).where(eq(repositories.id, row.id));
    linked.push({ ...row, repoUrl });
  }
  return linked;
}
