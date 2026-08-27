import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { featurePullRequests, features } from "@bento/db";
import { STAGE_ARTIFACT_DIR } from "@bento/core";
import { parseRepoUrl, type GitHubPublisher } from "@bento/github";
import type { RepositoryBundle } from "@bento/sandbox";
import type { Db } from "@bento/db";

const run = promisify(execFile);

/**
 * Answers git's credential prompt from the environment.
 *
 * The token must not go on the command line: every argv on the host is
 * readable by any process via ps, and an installation token is a write
 * credential for the organization's repositories. A process environment
 * is not readable the same way, so the helper reads it from there.
 */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$BENTO_PUSH_TOKEN"; }; f';

/**
 * Branches this will never push to, whatever it is asked.
 *
 * Work reaches these through a pull request and a person, never through
 * an agent run. A feature branch named "main" would otherwise mean a
 * stage's output was force-pushed straight onto the trunk, which is
 * exactly the merge nobody asked an agent to perform.
 */
const PROTECTED_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

export interface PublishableRepository {
  /** Null once the repository has been removed from the project. */
  id: string | null;
  name: string;
  repoUrl: string | null;
  githubRepoId?: number | null;
  defaultBranch: string;
  worktreePath?: string;
  bundle?: RepositoryBundle | null;
  exportBundle?: () => Promise<RepositoryBundle | null>;
}

export interface PublishedPullRequest {
  name: string;
  repoUrl: string;
  prNumber: number;
  url: string;
}

/** Downloads a private repository on the trusted host and strips credentials before transfer. */
export async function createRepositorySeed(
  publisher: GitHubPublisher,
  repoUrl: string,
  githubRepoId: number | undefined,
  baseBranch: string,
): Promise<Buffer> {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error(`not a GitHub remote: ${repoUrl}`);
  const remote = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const token = await publisher.pushToken(githubRepoId);
  const root = await mkdtemp(path.join(tmpdir(), "bento-seed-"));
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const bundlePath = path.join(root, "repository.bundle");
  await mkdir(home);
  const env = trustedGitEnv(home, token);
  try {
    await run(
      "git",
      [
        ...credentialArguments(),
        "clone",
        "--single-branch",
        "--branch",
        baseBranch,
        remote,
        checkout,
      ],
      { env },
    );
    await run("git", ["-C", checkout, "bundle", "create", bundlePath, `refs/heads/${baseBranch}`], { env });
    return await readFile(bundlePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Exports committed work without reading any remote or credential config. */
async function bundleFromWorktree(worktreePath: string, base: string): Promise<RepositoryBundle | null> {
  try {
    const { stdout: baseOut } = await run("git", ["-C", worktreePath, "rev-parse", `${base}^{commit}`]);
    const { stdout: headOut } = await run("git", ["-C", worktreePath, "rev-parse", "HEAD^{commit}"]);
    const baseSha = baseOut.trim();
    const headSha = headOut.trim();
    if (baseSha === headSha) return null;
    const dir = await mkdtemp(path.join(tmpdir(), "bento-export-"));
    const file = path.join(dir, "changes.bundle");
    try {
      await run("git", ["-C", worktreePath, "bundle", "create", file, "HEAD", `^${baseSha}`]);
      return { baseSha, headSha, data: await readFile(file) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

/**
 * Pushes the feature branch and opens a pull request in every
 * repository the agent committed in.
 *
 * A card spanning a frontend and a backend gets a pull request in each,
 * both on the same branch, and is only finished when both are. A
 * repository the agent did not touch gets nothing: an empty pull
 * request per stage per repository would bury the real ones.
 *
 * The server does this rather than the agent. An agent can read
 * anything its sandbox can, so a push credential handed to one is a
 * write credential for every repository in the organization, one prompt
 * injection away from leaving. The agent commits; this pushes.
 *
 * One repository failing does not stop the others: a pull request that
 * did open is still worth recording, and the run itself already
 * succeeded. Failures are returned rather than thrown.
 */
export async function publishFeatureBranches(
  db: Db,
  publisher: GitHubPublisher,
  args: {
    featureId: string;
    featureTitle: string;
    branch: string;
    repositories: PublishableRepository[];
  },
  options: {
    remoteUrl?: (owner: string, repo: string) => string;
    /**
     * Whether Bento's stage write-ups ride along. Off by default: a
     * reviewer opened a pull request to read a change and found six
     * generated markdown files in the diff.
     */
    includeStageNotes?: boolean;
  } = {},
): Promise<{ published: PublishedPullRequest[]; failures: { name: string; reason: string }[] }> {
  const published: PublishedPullRequest[] = [];
  const failures: { name: string; reason: string }[] = [];

  // Refused for the whole batch rather than per repository: if the
  // branch is the trunk, nothing about this run should reach a remote.
  if (PROTECTED_BRANCHES.has(args.branch.toLowerCase())) {
    // "all repositories" rather than the branch in the repo-name slot:
    // the transcript renders these as "Could not publish <name>: ...".
    return {
      published,
      failures: [
        {
          name: "any repository",
          reason: `the card's branch is named ${args.branch}, which is a protected branch. Rename the feature branch, then run again.`,
        },
      ],
    };
  }

  for (const repo of args.repositories) {
    // Publishing only happens when a stage asked for it, so a
    // repository that cannot be published is worth saying out loud
    // rather than skipping: the person who turned the mode on is
    // waiting for a pull request that will otherwise never appear.
    if (!repo.repoUrl) {
      failures.push({
        name: repo.name,
        reason:
          "its checkout has no GitHub remote, so there is nowhere to open the pull request. Add one with git remote add origin, then try again.",
      });
      continue;
    }
    const parsed = parseRepoUrl(repo.repoUrl);
    if (!parsed) {
      failures.push({ name: repo.name, reason: `not a GitHub remote: ${repo.repoUrl}` });
      continue;
    }

    try {
      const bundle =
        repo.exportBundle
          ? await repo.exportBundle()
          : repo.bundle !== undefined
          ? repo.bundle
          : repo.worktreePath
            ? await bundleFromWorktree(repo.worktreePath, repo.defaultBranch)
            : null;
      // No commits means no pull request, silently: in a project
      // spanning several repositories, the ones the agent left alone
      // are normal, not failures. The caller says something when the
      // whole batch came to nothing.
      if (!bundle) continue;

      const token = await publisher.pushToken(repo.githubRepoId ?? undefined);
      // The persisted URL is parsed only as an owner/repository identity.
      // A mutable worktree origin is never consulted, so an agent cannot
      // redirect this credential to a server it controls.
      const remote = options.remoteUrl?.(parsed.owner, parsed.repo)
        ?? `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      /**
       * The lease this push holds: the commit Bento itself last pushed
       * to the branch. A lease read from the remote at push time can
       * only ever agree with the remote, so it protected nothing; a
       * commit somebody pushed in between must fail the push, not be
       * rewritten away. Null (rows from before this column, or a first
       * push) falls back to the read-at-push behavior.
       */
      const [known] = await db
        .select({ headSha: featurePullRequests.headSha })
        .from(featurePullRequests)
        .where(and(eq(featurePullRequests.featureId, args.featureId), eq(featurePullRequests.repoUrl, repo.repoUrl)))
        .limit(1);
      const pushedHead = await pushBundle(bundle, remote, repo.defaultBranch, args.branch, token, {
        includeStageNotes: options.includeStageNotes === true,
        expectedRemoteHead: known?.headSha ?? null,
      });

      const pr = await publisher.ensurePullRequest({
        owner: parsed.owner,
        repo: parsed.repo,
        head: args.branch,
        base: repo.defaultBranch,
        title: args.featureTitle,
        body: `Opened by Bento for "${args.featureTitle}".`,
      });

      await db
        .insert(featurePullRequests)
        .values({
          featureId: args.featureId,
          repositoryId: repo.id,
          repoUrl: repo.repoUrl,
          number: pr.prNumber,
          url: pr.url,
          headSha: pushedHead,
        })
        .onConflictDoUpdate({
          target: [featurePullRequests.featureId, featurePullRequests.repoUrl],
          set: { number: pr.prNumber, url: pr.url, headSha: pushedHead, updatedAt: new Date() },
        });

      published.push({ name: repo.name, repoUrl: repo.repoUrl, prNumber: pr.prNumber, url: pr.url });
    } catch (err) {
      failures.push({ name: repo.name, reason: reasonOf(err) });
    }
  }

  // The feature's own pr_number mirrors the first repository's, the way
  // a project mirrors its first repository. Anything with room for one
  // pull request shows that one.
  const first = published[0];
  if (first) {
    await db.update(features).set({ prNumber: first.prNumber }).where(eq(features.id, args.featureId));
  }

  return { published, failures };
}

async function pushBundle(
  bundle: RepositoryBundle,
  remote: string,
  baseBranch: string,
  branch: string,
  token: string,
  options: {
    includeStageNotes: boolean;
    /** The commit Bento last pushed, when one is recorded; the lease to hold. */
    expectedRemoteHead?: string | null;
  },
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bento-publish-"));
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const bundlePath = path.join(root, "changes.bundle");
  await mkdir(home);
  await writeFile(bundlePath, bundle.data);
  const env = trustedGitEnv(home, token);
  const credentialArgs = credentialArguments();

  try {
    await run(
      "git",
      [
        ...credentialArgs,
        "clone",
        "--no-checkout",
        "--single-branch",
        "--branch",
        baseBranch,
        remote,
        checkout,
      ],
      { env },
    );
    await run("git", ["-C", checkout, "bundle", "verify", bundlePath], { env });
    await run("git", ["-C", checkout, "fetch", bundlePath, "HEAD"], { env });
    const { stdout: fetched } = await run("git", ["-C", checkout, "rev-parse", "FETCH_HEAD^{commit}"], { env });
    if (fetched.trim() !== bundle.headSha) throw new Error("exported Git bundle head did not match the declared commit");
    await run("git", ["-C", checkout, "cat-file", "-e", `${bundle.baseSha}^{commit}`], { env });
    await run("git", ["-C", checkout, "merge-base", "--is-ancestor", bundle.baseSha, bundle.headSha], { env });

    const { stdout: remoteRef } = await run(
      "git",
      [...credentialArgs, "ls-remote", remote, `refs/heads/${branch}`],
      { env },
    );
    const head = options.includeStageNotes
      ? bundle.headSha
      : await withoutStageNotes(checkout, bundle.headSha, path.join(root, "strip.index"), env);

    const actual = remoteRef.trim().split(/\s+/)[0] ?? "";
    /**
     * The real lease check happens here, against the commit Bento
     * itself last pushed, because a lease read from the remote a
     * moment before pushing can never disagree with the remote. A
     * mismatch means a person or a bot pushed to the branch since:
     * force pushing over that, rebased history especially, would
     * silently delete their commits.
     */
    if (options.expectedRemoteHead && actual && actual !== options.expectedRemoteHead) {
      throw new Error(
        `the branch moved on GitHub since Bento last pushed it (someone pushed commits to ${branch}). Pull those commits into the card's branch, or push manually, then try again.`,
      );
    }
    await run(
      "git",
      [
        "-C",
        checkout,
        ...credentialArgs,
        "push",
        `--force-with-lease=refs/heads/${branch}:${actual}`,
        remote,
        `${head}:refs/heads/${branch}`,
      ],
      { env },
    );
    return head;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The commit to push: the agent's work with Bento's own stage write-ups
 * taken back out.
 *
 * They are committed on the branch because that is how one stage's
 * output reaches the next, and how the card's Changes view reads them
 * later. None of that is a reason to put six generated markdown files
 * in front of a reviewer, so the pushed head carries a commit that
 * removes them: the pull request's diff is the code, and the notes are
 * still in the branch's history for anyone who goes looking.
 *
 * Returns the original commit when there is nothing to remove, which is
 * every repository the agent wrote no write-up in.
 */
async function withoutStageNotes(
  checkout: string,
  headSha: string,
  indexFile: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // Its own index file: the clone is --no-checkout, and this must not
  // disturb whatever git would otherwise think is staged.
  const stripEnv = { ...env, GIT_INDEX_FILE: indexFile };
  const git = (...args: string[]) => run("git", ["-C", checkout, ...args], { env: stripEnv });

  await git("read-tree", headSha);
  await git("rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", STAGE_ARTIFACT_DIR);
  const { stdout: stripped } = await git("write-tree");
  const { stdout: original } = await git("rev-parse", `${headSha}^{tree}`);
  if (stripped.trim() === original.trim()) return headSha;

  const { stdout: commit } = await run(
    "git",
    [
      "-C",
      checkout,
      // The clone has no gitconfig and this runs as a service, so the
      // identity has to be stated rather than found.
      "-c",
      "user.name=Bento",
      "-c",
      "user.email=agent@bento.dev",
      "commit-tree",
      stripped.trim(),
      "-p",
      headSha,
      "-m",
      `Remove Bento stage notes from the pull request\n\nThe write-ups under ${STAGE_ARTIFACT_DIR}/ stay on the branch, where each stage reads the last one's output. Turn this off under Settings, GitHub to include them here as well.`,
    ],
    { env: stripEnv },
  );
  return commit.trim();
}

function credentialArguments(): string[] {
  return ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];
}

function trustedGitEnv(home: string, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    BENTO_PUSH_TOKEN: token,
  };
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    // git writes the useful part to stderr; the message alone is just
    // the exit status.
    const stderr = (err as { stderr?: string }).stderr;
    return (stderr?.trim() || err.message).slice(0, 500);
  }
  return String(err);
}
