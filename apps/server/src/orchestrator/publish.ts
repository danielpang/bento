import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { featurePullRequests, features, swarmPullRequests, swarmTasks, swarms } from "@bento/db";
import { STAGE_ARTIFACT_DIR } from "@bento/core";
import { parseRepoUrl, type GitHubPublisher } from "@bento/github";
import type { RepositoryBundle } from "@bento/sandbox";
import type { Db } from "@bento/db";

const run = promisify(execFile);

/** True when publish failed because the bundle base is not an ancestor of HEAD. */
export function isAncestryPublishFailure(reason: string): boolean {
  return /merge-base.*--is-ancestor/i.test(reason);
}

/**
 * The fork point between the default branch and HEAD. Used as the
 * bundle base so a feature branched before main moved forward still
 * publishes; the default branch tip alone is not always an ancestor.
 */
export async function resolvePublishBaseSha(repoPath: string, defaultBranch: string): Promise<string> {
  const baseRef = await resolveDefaultBranchRef(repoPath, defaultBranch);
  try {
    const { stdout } = await run("git", ["-C", repoPath, "merge-base", baseRef, "HEAD"]);
    const sha = stdout.trim();
    if (sha) return sha;
  } catch {
    // Fall back to the branch tip when histories do not share a merge-base.
  }
  const { stdout } = await run("git", ["-C", repoPath, "rev-parse", `${baseRef}^{commit}`]);
  return stdout.trim();
}

async function resolveDefaultBranchRef(repoPath: string, defaultBranch: string): Promise<string> {
  try {
    await run("git", ["-C", repoPath, "rev-parse", "--verify", `${defaultBranch}^{commit}`]);
    return defaultBranch;
  } catch {
    return `origin/${defaultBranch}`;
  }
}

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
  /** True when opened as a draft because the branch could not be rebased cleanly. */
  draft?: boolean;
}

/**
 * The organization's GitHub connection cannot read this repository.
 *
 * The run stops before a machine is made. It is the project's
 * configuration, so callers do not send it to error tracking: an
 * exception there opens an issue for something a token or a GitHub
 * App install fixes.
 */
export class RepositoryAccessError extends Error {
  readonly label: string;

  constructor(label: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepositoryAccessError";
    this.label = label;
  }
}

export function isRepositoryAccessError(err: unknown): err is RepositoryAccessError {
  return err instanceof RepositoryAccessError || (err instanceof Error && err.name === "RepositoryAccessError");
}

/** What to tell a person when GitHub will not show the repository at all. */
export function inaccessibleRepositoryMessage(label: string): string {
  return (
    `${label} could not be cloned. GitHub says the repository was not found. ` +
    "That is also what GitHub says when this organization's GitHub connection cannot see a private repository, " +
    "and when the repository was renamed or deleted. Check it under Settings, Repositories. " +
    "Then save a GitHub token under Settings, GitHub, or install the GitHub App on the repository, and run again."
  );
}

/** What to tell a person when the connection can see the repository but cannot read its git data. */
export function repositoryContentsMessage(label: string): string {
  return (
    `${label} could not be cloned because this organization's GitHub connection cannot read the repository. ` +
    "Grant the GitHub App Contents access, or save a token that can read the repository under Settings, GitHub, and run again."
  );
}

/**
 * The URL a seed clone is willing to fetch.
 *
 * GitHub's own clone URL is rewritten to https so a ssh form cannot
 * pick up a key on this host. A loopback URL or an absolute path is a
 * test standing in for that host. Anything else is refused: the seed
 * must not follow a clone URL that is not the repository GitHub named.
 */
export function cloneUrlForSeed(cloneUrl: string, fullName: string): string {
  const parsed = parseRepoUrl(cloneUrl);
  if (parsed && /github\.com/i.test(cloneUrl)) {
    return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  }
  if (cloneUrl.startsWith("/") || /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(cloneUrl)) return cloneUrl;
  throw new Error(`GitHub returned an unexpected clone URL for ${fullName}`);
}

/**
 * Downloads a private repository on the trusted host and strips
 * credentials before transfer.
 *
 * Returns the branch the bundle carries alongside the bytes. It is
 * usually the branch asked for, but when the stored default branch no
 * longer exists on the remote the clone falls back to the remote's real
 * default, so the caller must record which branch it got and hand that
 * name to the sandbox.
 *
 * The clone URL and the token's repository id come from GitHub when
 * the publisher can ask. The id stored on the project row is what the
 * repository was when it was connected. After a rename, or when that
 * id no longer matches the URL, a token limited to the stored id
 * cannot see the URL and git says the repository was not found. Asking
 * first clones the repository GitHub returns now. When GitHub will not
 * show it, this stops before git runs.
 */
export async function createRepositorySeed(
  publisher: Pick<GitHubPublisher, "pushToken" | "resolveRepository">,
  repoUrl: string,
  githubRepoId: number | undefined,
  baseBranch: string,
): Promise<{ bundle: Buffer; baseBranch: string }> {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error(`not a GitHub remote: ${repoUrl}`);
  const storedLabel = `${parsed.owner}/${parsed.repo}`;
  const visible = publisher.resolveRepository
    ? await publisher.resolveRepository({ owner: parsed.owner, repo: parsed.repo })
    : undefined;
  if (visible === null) throw new RepositoryAccessError(storedLabel, inaccessibleRepositoryMessage(storedLabel));
  if (visible && !visible.canClone) {
    throw new RepositoryAccessError(visible.fullName, repositoryContentsMessage(visible.fullName));
  }

  const remote = visible
    ? cloneUrlForSeed(visible.cloneUrl, visible.fullName)
    : `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const label = visible?.fullName ?? storedLabel;
  const tokenRepoId = visible?.id ?? githubRepoId;
  const root = await mkdtemp(path.join(tmpdir(), "bento-seed-"));
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const bundlePath = path.join(root, "repository.bundle");
  await mkdir(home);
  try {
    const { branch: resolvedBranch, env } = await cloneSeedCheckout(publisher, {
      remote,
      label,
      baseBranch,
      checkout,
      home,
      tokenRepoId,
    });
    await run("git", ["-C", checkout, "bundle", "create", bundlePath, `refs/heads/${resolvedBranch}`], { env });
    return { bundle: await readFile(bundlePath), baseBranch: resolvedBranch };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Clones the seed, and retries once with the installation-wide token
 * when a token limited to one repository id cannot see the remote.
 *
 * A personal access token ignores the id, so the second call is the
 * same credential and is not asked to clone again. When GitHub has
 * already said it will not show the repository, the clone is not
 * attempted.
 */
async function cloneSeedCheckout(
  publisher: Pick<GitHubPublisher, "pushToken">,
  args: {
    remote: string;
    label: string;
    baseBranch: string;
    checkout: string;
    home: string;
    tokenRepoId: number | undefined;
  },
): Promise<{ branch: string; env: NodeJS.ProcessEnv }> {
  const token =
    args.tokenRepoId === undefined ? await publisher.pushToken() : await publisher.pushToken(args.tokenRepoId);
  const clone = (credential: string) => {
    const env = trustedGitEnv(args.home, credential);
    return cloneBaseBranch({
      remote: args.remote,
      label: args.label,
      baseBranch: args.baseBranch,
      checkout: args.checkout,
      env,
      fallbackToDefaultBranch: true,
    }).then((branch) => ({ branch, env }));
  };
  try {
    return await clone(token);
  } catch (err) {
    if (args.tokenRepoId === undefined || !isRepositoryAccessError(err)) throw err;
    const broader = await publisher.pushToken();
    if (broader === token) throw err;
    await rm(args.checkout, { recursive: true, force: true });
    return clone(broader);
  }
}

/** Exports committed work without reading any remote or credential config. */
async function bundleFromWorktree(worktreePath: string, defaultBranch: string): Promise<RepositoryBundle | null> {
  try {
    const baseSha = await resolvePublishBaseSha(worktreePath, defaultBranch);
    const { stdout: headOut } = await run("git", ["-C", worktreePath, "rev-parse", "HEAD^{commit}"]);
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
/**
 * What a publish did per repository. `notesOnly` names the repositories
 * whose branch changed nothing but Bento's own stage write-ups: with
 * those kept out of the pull request there was nothing for a reviewer,
 * so nothing was pushed and no pull request was opened.
 */
export interface PublishOutcome {
  published: PublishedPullRequest[];
  failures: { name: string; reason: string }[];
  notesOnly: string[];
}

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
    /**
     * Push the branch and open a draft pull request even when the
     * bundle base is not an ancestor of HEAD. Used when a rebase run
     * could not be started and something on GitHub is still useful.
     */
    draft?: boolean;
    /** When set, only these repository names are published. */
    onlyRepositories?: string[];
  } = {},
): Promise<PublishOutcome> {
  const result = await publishBranches(publisher, {
    branch: args.branch,
    title: args.featureTitle,
    body: options.draft
      ? [
          `Opened by Bento for "${args.featureTitle}".`,
          "",
          "This pull request is a draft because the branch could not be rebased onto the base branch automatically. It may have merge conflicts until the branch is rebased.",
        ].join("\n")
      : `Opened by Bento for "${args.featureTitle}".`,
    repositories: args.repositories,
    protectedBranchRefusal: (branch) =>
      `the card's branch is named ${branch}, which is a protected branch. Rename the feature branch, then run again.`,
    ...options,
    /**
     * The lease this push holds: the commit Bento itself last pushed
     * to the branch. A lease read from the remote at push time can
     * only ever agree with the remote, so it protected nothing; a
     * commit somebody pushed in between must fail the push, not be
     * rewritten away. Null (rows from before this column, or a first
     * push) falls back to the read-at-push behavior.
     */
    lease: async (repo) => {
      const [known] = await db
        .select({ headSha: featurePullRequests.headSha })
        .from(featurePullRequests)
        .where(
          and(
            eq(featurePullRequests.featureId, args.featureId),
            eq(featurePullRequests.repoUrl, repo.repoUrl),
            // This branch's lease, not the card's. A card that merged
            // one branch and started another has a row for each, and
            // holding the old branch's head against a push to the new
            // one would fail every publish after the first rotation.
            eq(featurePullRequests.branch, args.branch),
          ),
        )
        .limit(1);
      return known?.headSha ?? null;
    },
    record: async (repo, pr) => {
      await db
        .insert(featurePullRequests)
        .values({
          featureId: args.featureId,
          repositoryId: repo.id,
          repoUrl: repo.repoUrl,
          branch: args.branch,
          number: pr.prNumber,
          url: pr.url,
          headSha: pr.headSha,
        })
        .onConflictDoUpdate({
          target: [featurePullRequests.featureId, featurePullRequests.repoUrl, featurePullRequests.branch],
          set: { number: pr.prNumber, url: pr.url, headSha: pr.headSha, updatedAt: new Date() },
        });
    },
  });

  // The feature's own pr_number mirrors the first repository's, the way
  // a project mirrors its first repository. Anything with room for one
  // pull request shows that one.
  const first = result.published[0];
  if (first) {
    await db.update(features).set({ prNumber: first.prNumber }).where(eq(features.id, args.featureId));
  }

  return result;
}

/**
 * Pushes a swarm's branch and opens one pull request per repository it
 * touched.
 *
 * The same mechanism as a card's, deliberately: the bundle export, the
 * trusted checkout, the lease held against the commit Bento itself last
 * pushed, and the write-up stripping are all things a swarm needs
 * exactly as a card needs them, and a second copy of any of them is a
 * second place for the push credential to be got wrong. What differs is
 * only which rows record the result and what the body says.
 *
 * The row keeps the head that was pushed, which is the lease the next
 * publish of the same swarm holds. A swarm that is reopened in phase 4
 * will publish again onto the same branch, and a push that could not
 * tell its own last commit from somebody else's would force over a
 * reviewer's.
 */
export async function publishSwarmBranches(
  db: Db,
  publisher: GitHubPublisher,
  args: {
    swarmId: string;
    title: string;
    body: string;
    branch: string;
    repositories: PublishableRepository[];
  },
  options: {
    remoteUrl?: (owner: string, repo: string) => string;
    includeStageNotes?: boolean;
  } = {},
): Promise<PublishOutcome> {
  return publishBranches(publisher, {
    branch: args.branch,
    title: args.title,
    body: args.body,
    repositories: args.repositories,
    protectedBranchRefusal: (branch) =>
      `this swarm's branch is named ${branch}, which is a protected branch. Nothing was pushed.`,
    ...options,
    /*
     * The branch is pushed after every landing now, so the commit Bento
     * last put there is usually that push's, not the pull request's.
     * Either is Bento's own; the newer one is the lease.
     */
    lease: async (repo) => {
      const [swarm] = await db
        .select({ pushedHeads: swarms.pushedHeads })
        .from(swarms)
        .where(eq(swarms.id, args.swarmId))
        .limit(1);
      const pushed = swarm?.pushedHeads?.[repo.repoUrl];
      if (pushed) return pushed;
      const [known] = await db
        .select({ headSha: swarmPullRequests.headSha })
        .from(swarmPullRequests)
        .where(and(eq(swarmPullRequests.swarmId, args.swarmId), eq(swarmPullRequests.repoUrl, repo.repoUrl)))
        .limit(1);
      return known?.headSha ?? null;
    },
    record: async (repo, pr) => {
      await recordPushedHead(db, { swarmId: args.swarmId }, repo.repoUrl, pr.headSha);
      await db
        .insert(swarmPullRequests)
        .values({
          swarmId: args.swarmId,
          repositoryId: repo.id,
          repoUrl: repo.repoUrl,
          number: pr.prNumber,
          url: pr.url,
          headSha: pr.headSha,
        })
        .onConflictDoUpdate({
          target: [swarmPullRequests.swarmId, swarmPullRequests.repoUrl],
          set: { number: pr.prNumber, url: pr.url, headSha: pr.headSha, updatedAt: new Date() },
        });
    },
  });
}

/**
 * Records the commit Bento just pushed to a branch, as the lease the
 * next push of it holds. Merged into the jsonb rather than written
 * over it, so two repositories recorded at once do not erase each
 * other, and a task's other flags are never read and written back.
 */
export async function recordPushedHead(
  db: Pick<Db, "update">,
  owner: { swarmId: string } | { taskId: string },
  repoUrl: string,
  headSha: string,
): Promise<void> {
  const entry = JSON.stringify({ [repoUrl]: headSha });
  if ("taskId" in owner) {
    await db
      .update(swarmTasks)
      .set({
        flags: sql`jsonb_set(coalesce(${swarmTasks.flags}, '{}'::jsonb), '{pushedHeads}', coalesce(${swarmTasks.flags}->'pushedHeads', '{}'::jsonb) || ${entry}::jsonb)`,
      })
      .where(eq(swarmTasks.id, owner.taskId));
    return;
  }
  await db
    .update(swarms)
    .set({ pushedHeads: sql`${swarms.pushedHeads} || ${entry}::jsonb` })
    .where(eq(swarms.id, owner.swarmId));
}

/** What pushing one branch to every repository it has commits in did. */
export interface PushOutcome {
  pushed: { name: string; repoUrl: string; headSha: string }[];
  failures: { name: string; reason: string }[];
}

/**
 * One branch to GitHub, with no pull request.
 *
 * A swarm's branches leave their machines as soon as there is
 * something on them: a worker's when its run ends, the swarm's after
 * every landing. A machine that is lost after that loses nothing, and
 * the pull requests are a separate choice a person makes at the end.
 * The same push the publish path makes: the server holds the
 * credential, the bundle leaves the sandbox with no remote configured,
 * and the push holds a lease against the commit Bento last pushed, so
 * a person's commits on the branch are refused rather than overwritten.
 */
export async function pushBranches(
  publisher: GitHubPublisher,
  plan: {
    branch: string;
    repositories: PublishableRepository[];
    lease: (repo: PublishableRemote) => Promise<string | null>;
    record: (repo: PublishableRemote, headSha: string) => Promise<void>;
    /** A commit inside the bundle to push instead of its head, per repository. */
    target?: (repo: PublishableRemote) => string | undefined;
    remoteUrl?: (owner: string, repo: string) => string;
  },
): Promise<PushOutcome> {
  const pushed: PushOutcome["pushed"] = [];
  const failures: PushOutcome["failures"] = [];
  if (PROTECTED_BRANCHES.has(plan.branch.toLowerCase())) {
    return { pushed, failures: [{ name: "any repository", reason: `${plan.branch} is a protected branch. Nothing was pushed.` }] };
  }
  for (const repo of plan.repositories) {
    // No remote is not a failure here: nothing asked for a pull
    // request, and a project with no GitHub keeps its branches where
    // they always were.
    if (!repo.repoUrl) continue;
    const remoteRepo: PublishableRemote = { ...repo, repoUrl: repo.repoUrl };
    const parsed = parseRepoUrl(repo.repoUrl);
    if (!parsed) continue;
    try {
      const bundle = repo.exportBundle
        ? await repo.exportBundle()
        : repo.bundle !== undefined
          ? repo.bundle
          : repo.worktreePath
            ? await bundleFromWorktree(repo.worktreePath, repo.defaultBranch)
            : null;
      if (!bundle) continue;
      const token = await publisher.pushToken(repo.githubRepoId ?? undefined);
      const remote = plan.remoteUrl?.(parsed.owner, parsed.repo) ?? `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      const target = plan.target?.(remoteRepo);
      const head = await pushBundle(bundle, remote, repo.defaultBranch, plan.branch, token, {
        includeStageNotes: false,
        label: `${parsed.owner}/${parsed.repo}`,
        expectedRemoteHead: await plan.lease(remoteRepo),
        ...(target ? { target } : {}),
      });
      if (head === null) continue;
      await plan.record(remoteRepo, head);
      pushed.push({ name: repo.name, repoUrl: repo.repoUrl, headSha: head });
    } catch (err) {
      failures.push({ name: repo.name, reason: reasonOf(err) });
    }
  }
  return { pushed, failures };
}

/**
 * A branch Bento pushed, read back from GitHub as a bundle a sandbox
 * can fetch: how a machine that was lost is rebuilt from what was
 * pushed before it went. Null when the branch is not on the remote.
 *
 * `selfContained` carries every object (what a landing needs); without
 * it the bundle stops at the base branch, which a sandbox seeded from
 * that base already has.
 */
export async function fetchRemoteBranchBundle(
  publisher: GitHubPublisher,
  repo: { repoUrl: string; githubRepoId?: number | null; defaultBranch: string },
  branch: string,
  options: { selfContained?: boolean; remoteUrl?: (owner: string, repo: string) => string } = {},
): Promise<RepositoryBundle | null> {
  const parsed = parseRepoUrl(repo.repoUrl);
  if (!parsed) return null;
  const remote = options.remoteUrl?.(parsed.owner, parsed.repo) ?? `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const token = await publisher.pushToken(repo.githubRepoId ?? undefined);
  const root = await mkdtemp(path.join(tmpdir(), "bento-restore-"));
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const bundlePath = path.join(root, "branch.bundle");
  await mkdir(home);
  const env = trustedGitEnv(home, token);
  try {
    const { stdout: listed } = await run("git", [...credentialArguments(), "ls-remote", remote, `refs/heads/${branch}`], { env });
    if (!listed.trim()) return null;
    await cloneBaseBranch({ remote, label: `${parsed.owner}/${parsed.repo}`, baseBranch: repo.defaultBranch, checkout, env, flags: ["--no-checkout"] });
    await run("git", ["-C", checkout, ...credentialArguments(), "fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/heads/${branch}`], { env });
    const { stdout: headOut } = await run("git", ["-C", checkout, "rev-parse", `refs/heads/${branch}^{commit}`], { env });
    const headSha = headOut.trim();
    const { stdout: baseOut } = await run("git", ["-C", checkout, "merge-base", `origin/${repo.defaultBranch}`, headSha], { env });
    const baseSha = baseOut.trim();
    await run(
      "git",
      ["-C", checkout, "bundle", "create", bundlePath, `refs/heads/${branch}`, ...(options.selfContained ? [] : [`^${baseSha}`])],
      { env },
    );
    return { baseSha, headSha, data: await readFile(bundlePath) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A repository that got as far as having a remote to push to. */
type PublishableRemote = PublishableRepository & { repoUrl: string };

/**
 * One branch, into every repository it has commits in.
 *
 * Both boards go through here, for the reason both boards provision
 * through one function: everything below this line is about a branch
 * and a credential rather than about a card or a swarm, and a fix to
 * any of it has to reach both. What a caller brings is the lease to
 * hold, the row to write, and the words for the refusals.
 *
 * One repository failing does not stop the others: a pull request that
 * did open is still worth recording, and the run itself already
 * succeeded. Failures are returned rather than thrown.
 */
async function publishBranches(
  publisher: GitHubPublisher,
  plan: {
    branch: string;
    title: string;
    body: string;
    repositories: PublishableRepository[];
    /** What to say when the branch is one nothing may push to. */
    protectedBranchRefusal: (branch: string) => string;
    lease: (repo: PublishableRemote) => Promise<string | null>;
    record: (
      repo: PublishableRemote,
      pr: { prNumber: number; url: string; headSha: string },
    ) => Promise<void>;
    remoteUrl?: (owner: string, repo: string) => string;
    includeStageNotes?: boolean;
    draft?: boolean;
    onlyRepositories?: string[];
  },
): Promise<PublishOutcome> {
  const published: PublishedPullRequest[] = [];
  const failures: { name: string; reason: string }[] = [];
  const notesOnly: string[] = [];

  // Refused for the whole batch rather than per repository: if the
  // branch is the trunk, nothing about this run should reach a remote.
  if (PROTECTED_BRANCHES.has(plan.branch.toLowerCase())) {
    // "all repositories" rather than the branch in the repo-name slot:
    // the transcript renders these as "Could not publish <name>: ...".
    return {
      published,
      failures: [{ name: "any repository", reason: plan.protectedBranchRefusal(plan.branch) }],
      notesOnly,
    };
  }

  const only = plan.onlyRepositories ? new Set(plan.onlyRepositories) : null;

  for (const repo of plan.repositories) {
    if (only && !only.has(repo.name)) continue;
    // Publishing only happens when something asked for it, so a
    // repository that cannot be published is worth saying out loud
    // rather than skipping: the person waiting for a pull request is
    // otherwise waiting for one that will never appear.
    if (!repo.repoUrl) {
      failures.push({
        name: repo.name,
        reason:
          "its checkout has no GitHub remote, so there is nowhere to open the pull request. Add one with git remote add origin, then try again.",
      });
      continue;
    }
    const remoteRepo: PublishableRemote = { ...repo, repoUrl: repo.repoUrl };
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
      const remote = plan.remoteUrl?.(parsed.owner, parsed.repo)
        ?? `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      const expectedRemoteHead = await plan.lease(remoteRepo);
      const pushedHead = await pushBundle(bundle, remote, repo.defaultBranch, plan.branch, token, {
        includeStageNotes: plan.includeStageNotes === true,
        label: `${parsed.owner}/${parsed.repo}`,
        expectedRemoteHead,
        skipAncestryCheck: plan.draft === true,
      });
      if (pushedHead === null) {
        notesOnly.push(repo.name);
        continue;
      }

      const pr = await publisher.ensurePullRequest({
        owner: parsed.owner,
        repo: parsed.repo,
        head: plan.branch,
        base: repo.defaultBranch,
        title: plan.title,
        body: plan.body,
        draft: plan.draft === true,
      });

      await plan.record(remoteRepo, { prNumber: pr.prNumber, url: pr.url, headSha: pushedHead });

      published.push({
        name: repo.name,
        repoUrl: repo.repoUrl,
        prNumber: pr.prNumber,
        url: pr.url,
        ...(plan.draft ? { draft: true } : {}),
      });
    } catch (err) {
      failures.push({ name: repo.name, reason: reasonOf(err) });
    }
  }

  return { published, failures, notesOnly };
}

async function pushBundle(
  bundle: RepositoryBundle,
  remote: string,
  baseBranch: string,
  branch: string,
  token: string,
  options: {
    includeStageNotes: boolean;
    /** owner/repository, for anything this has to say about the remote. */
    label: string;
    /** The commit Bento last pushed, when one is recorded; the lease to hold. */
    expectedRemoteHead?: string | null;
    /** Skip the bundle-base ancestry check and push HEAD anyway. */
    skipAncestryCheck?: boolean;
    /**
     * A commit inside the bundle to push instead of its head: a task's
     * branch is pushed as the swarm's head at the moment that task
     * landed, which a later landing has since built on.
     */
    target?: string;
  },
): Promise<string | null> {
  const root = await mkdtemp(path.join(tmpdir(), "bento-publish-"));
  const checkout = path.join(root, "checkout");
  const home = path.join(root, "home");
  const bundlePath = path.join(root, "changes.bundle");
  await mkdir(home);
  await writeFile(bundlePath, bundle.data);
  const env = trustedGitEnv(home, token);
  const credentialArgs = credentialArguments();

  try {
    await cloneBaseBranch({
      remote,
      label: options.label,
      baseBranch,
      checkout,
      env,
      flags: ["--no-checkout"],
    });
    await run("git", ["-C", checkout, "bundle", "verify", bundlePath], { env });
    await run("git", ["-C", checkout, "fetch", bundlePath, "HEAD"], { env });
    const { stdout: fetched } = await run("git", ["-C", checkout, "rev-parse", "FETCH_HEAD^{commit}"], { env });
    if (fetched.trim() !== bundle.headSha) throw new Error("exported Git bundle head did not match the declared commit");
    if (!options.skipAncestryCheck) {
      await run("git", ["-C", checkout, "cat-file", "-e", `${bundle.baseSha}^{commit}`], { env });
      await run("git", ["-C", checkout, "merge-base", "--is-ancestor", bundle.baseSha, bundle.headSha], { env });
    }

    const { stdout: remoteRef } = await run(
      "git",
      [...credentialArgs, "ls-remote", remote, `refs/heads/${branch}`],
      { env },
    );
    const tip = options.target ?? bundle.headSha;
    if (options.target) {
      await run("git", ["-C", checkout, "merge-base", "--is-ancestor", options.target, bundle.headSha], { env });
    }
    const head = options.includeStageNotes
      ? tip
      : await withoutStageNotes(checkout, tip, path.join(root, "strip.index"), env);
    // A stage that only wrote its notes (a plan, say) leaves a branch
    // that, with the notes taken out, is the base again. Pushing it
    // would open a pull request with no files changed, so it is held
    // back until a stage commits something a reviewer can read.
    if (head !== tip && (await sameTreeAsForkPoint(checkout, head, env))) return null;

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
        `the branch moved on GitHub since Bento last pushed it (someone pushed commits to ${branch}). Pull those commits into this branch, or push manually, then try again.`,
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
 * Whether `head` changes nothing relative to where it left the base
 * branch the clone checked out. The fork point rather than the base's
 * tip, because that is what a pull request's diff is measured against.
 * Unknown (no common history) reads as "changes something", so the
 * push goes ahead as it would have before this check existed.
 */
async function sameTreeAsForkPoint(checkout: string, head: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout: forkPoint } = await run("git", ["-C", checkout, "merge-base", "HEAD", head], { env });
    const { stdout: forkTree } = await run("git", ["-C", checkout, "rev-parse", `${forkPoint.trim()}^{tree}`], { env });
    const { stdout: headTree } = await run("git", ["-C", checkout, "rev-parse", `${head}^{tree}`], { env });
    return forkTree.trim() === headTree.trim();
  } catch {
    return false;
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
      "user.email=no-reply@usebento.ai",
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

/**
 * Clones the base branch, and returns the branch it actually took.
 *
 * git's own word for a missing branch is "fatal: Remote branch main not
 * found in upstream origin", wrapped in a command line and a temporary
 * path nobody typed, and it arrives as the whole reason a run failed or
 * a pull request never appeared. Two repositories hit it: one connected
 * before its first commit, which has no branches at all, and one whose
 * default branch was renamed after it was connected.
 *
 * A caller that only needs a starting point for the clone, and not the
 * stored name in particular, sets `fallbackToDefaultBranch`. The seed
 * for a run does: the remote still reports a real default branch through
 * its HEAD, so a first clone that fails for want of the stored branch
 * reads that default and clones it instead, and the returned name is the
 * branch that got cloned so the seed and the sandbox agree on it. The
 * repository with no commits has no default branch to find and still
 * gets the error that says what to do.
 *
 * Publishing does not set it. There the stored branch is the pull
 * request's base as well as the clone, so a rename is a mismatch a
 * person must reconcile, not one this quietly papers over.
 *
 * A repository GitHub will not show is a different failure, and it
 * must not travel as the command that hit it. execFile's message is
 * the whole argv, and that argv carries the credential helper, so the
 * run record and the exception capture were a git command line ending
 * in "repository not found". GitHub uses that same sentence when the
 * repository is private and this organization's installation cannot
 * see it, and when the repository was renamed or deleted. The person
 * gets a sentence that says so. git's own line stays on the cause,
 * without the command.
 */
/** How long a clone GitHub refused waits before it is asked once more. */
export const CLONE_ACCESS_RETRY_MS = 2_000;

export async function cloneBaseBranch(args: {
  remote: string;
  /** owner/repository, because the run record does not name it otherwise. */
  label: string;
  baseBranch: string;
  checkout: string;
  env: NodeJS.ProcessEnv;
  /** Clone flags this caller wants, ahead of the branch selection. */
  flags?: string[];
  /** Clone the remote's real default branch when the stored one is gone. */
  fallbackToDefaultBranch?: boolean;
}): Promise<string> {
  const cloneBranch = (branch: string) =>
    run(
      "git",
      [
        ...credentialArguments(),
        "clone",
        ...(args.flags ?? []),
        "--single-branch",
        "--branch",
        branch,
        args.remote,
        args.checkout,
      ],
      { env: args.env },
    );
  try {
    try {
      await cloneBranch(args.baseBranch);
    } catch (first) {
      /*
       * GitHub answers "not found" or a refused credential now and then
       * for a repository it served a moment before (a swarm planner hit
       * it right after a deploy, and the same clone worked two seconds
       * later). Read as the project's failure, that ends and bills the
       * run and hands it to a person, so it is asked once more first.
       */
      if (!inaccessibleCloneExplanation(args.label, args.remote, first)) throw first;
      await rm(args.checkout, { recursive: true, force: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, CLONE_ACCESS_RETRY_MS));
      await cloneBranch(args.baseBranch);
    }
    return args.baseBranch;
  } catch (err) {
    const access = inaccessibleCloneExplanation(args.label, args.remote, err);
    if (access) throw new RepositoryAccessError(args.label, access, { cause: cloneFailureCause(err) });
    if (!missingBranchFailure(err)) throw err;
    if (args.fallbackToDefaultBranch) {
      const fallback = await remoteDefaultBranch(args.remote, args.env);
      if (fallback && fallback !== args.baseBranch) {
        await cloneBranch(fallback);
        return fallback;
      }
    }
    // Chained, so git's own line is still in the server log and in the
    // exception capture. It is only kept out of what the person reads.
    throw new Error(
      `${args.label} has no branch named ${args.baseBranch}. ` +
        "A repository with no commits yet has no branches at all, so push a first commit. " +
        "If its default branch was renamed after the repository was connected, remove the " +
        "repository under Repositories and add it again to pick up the new name.",
      { cause: err },
    );
  }
}

/**
 * The branch the remote's HEAD points at, its real default branch, or
 * null when the remote reports none. A repository with no commits has an
 * unborn HEAD and lists nothing here, which is how the empty case is
 * told apart from the renamed one.
 */
async function remoteDefaultBranch(remote: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      [...credentialArguments(), "ls-remote", "--symref", remote, "HEAD"],
      { env },
    );
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a failed clone failed for want of the branch, rather than for
 * a credential, a network, or a repository that is not there. git says
 * so on stderr, which execFile also folds into the error message, so
 * both are read: a driver that keeps only one of them still matches.
 */
function missingBranchFailure(err: unknown): boolean {
  return /Remote branch .+ not found in upstream/i.test(gitFailureText(err));
}

/**
 * What to tell a person when the clone never reached a branch because
 * the remote hid the repository or refused the credential.
 *
 * Null for every other failure. A missing branch has its own sentence.
 * A network error is left as git wrote it: telling someone to fix the
 * repository would be the wrong advice when this host cannot reach it.
 */
export function inaccessibleCloneExplanation(label: string, remote: string, err: unknown): string | null {
  const text = gitFailureText(err);
  if (/Remote branch .+ not found in upstream/i.test(text)) return null;
  const github = /github\.com/i.test(remote);
  if (repositoryNotFound(text)) {
    if (!github) {
      return (
        `${label} could not be cloned from ${remote}. The remote says the repository was not found. ` +
        "Check the URL and its access under Settings, Repositories, then run again."
      );
    }
    return inaccessibleRepositoryMessage(label);
  }
  if (credentialRejected(text)) {
    if (!github) {
      return (
        `${label} could not be cloned from ${remote} because the remote rejected the credentials. ` +
        "Check its access under Settings, Repositories, then run again."
      );
    }
    return (
      `${label} could not be cloned because GitHub rejected the credentials. ` +
      "Reconnect GitHub under Settings, GitHub, and confirm the GitHub App is installed on this repository, then run again."
    );
  }
  return null;
}

function repositoryNotFound(text: string): boolean {
  return (
    /repository not found/i.test(text) ||
    /fatal: repository '.+' not found/i.test(text) ||
    /requested URL returned error: 404/i.test(text)
  );
}

function credentialRejected(text: string): boolean {
  return (
    /authentication failed/i.test(text) ||
    /invalid username or token/i.test(text) ||
    /could not read Username/i.test(text) ||
    /terminal prompts disabled/i.test(text) ||
    /write access to repository not granted/i.test(text) ||
    /requested URL returned error: 401/i.test(text) ||
    /requested URL returned error: 403/i.test(text)
  );
}

/** stderr plus the message, which is where execFile puts git's fatal line. */
function gitFailureText(err: unknown): string {
  const stderr = gitStderr(err);
  return `${stderr}\n${err instanceof Error ? err.message : String(err)}`;
}

function gitStderr(err: unknown): string {
  const stderr = typeof err === "object" && err !== null ? (err as { stderr?: unknown }).stderr : undefined;
  return typeof stderr === "string" ? stderr : "";
}

/**
 * git's own lines, for the log and the exception cause.
 *
 * The command is left out. It is how the helper is spelled, and it is
 * not a fact about the repository.
 */
function cloneFailureCause(err: unknown): Error {
  const lines = gitStderr(err)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/credential\.helper|BENTO_PUSH_TOKEN/i.test(line));
  return new Error(lines.slice(-6).join("\n") || "git clone failed");
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
