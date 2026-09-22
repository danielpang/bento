import { and, eq, isNull } from "drizzle-orm";
import { githubInstallations, secrets, type Db } from "@bento/db";
import { GitHubTokenClient, type GitHubClient, type GitHubPublisher, type ReviewThread } from "@bento/github";
import type { GitHubAppClient } from "@bento/github";
import type { AppContext } from "./context.js";

/**
 * Resolves the server-owned GitHub client for one tenant.
 *
 * `db` is the connection the lookups run on. HTTP routes pass their
 * request's `db(c, ctx)`: in multi mode that is the tenant transaction,
 * which already holds a pooled connection, and a nested `ctx.db` read
 * from inside it would check out a second one per request, halving the
 * pool. Workers outside a request omit it and use the owner pool.
 */
export async function githubForOrganization(
  ctx: AppContext,
  organizationId: string | null,
  db: Db = ctx.db,
): Promise<GitHubAppClient | undefined> {
  if (!ctx.githubApp || !organizationId) return undefined;
  const [row] = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId))
    .limit(1);
  return row ? ctx.githubApp.forInstallation(row.installationId) : undefined;
}

/**
 * The GitHub connection for reading gates and publishing branches: the
 * organization's App installation when there is one, otherwise a stored
 * GITHUB_TOKEN. The token path is what makes Create a pull request work
 * for self-hosters and local mode, where no App exists to install. The
 * token is a server credential exactly like the App key: it answers
 * pushes on the trusted host and is never part of an agent's
 * environment.
 */
export async function githubConnectionFor(
  ctx: AppContext,
  organizationId: string | null,
  db: Db = ctx.db,
): Promise<(GitHubClient & GitHubPublisher) | undefined> {
  const app = await githubForOrganization(ctx, organizationId, db);
  if (app) return app;

  const [row] = await db
    .select({ ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(
      and(
        organizationId ? eq(secrets.organizationId, organizationId) : isNull(secrets.organizationId),
        eq(secrets.name, "GITHUB_TOKEN"),
      ),
    )
    .limit(1);
  if (row) {
    try {
      return new GitHubTokenClient(ctx.secretBox.decrypt(row.ciphertext));
    } catch {
      // Encrypted under a rotated key: fall through to the environment,
      // and let publishing report that no connection is configured.
    }
  }

  // Local mode trusts its own environment the way agent keys do. Multi
  // mode does not: the operator's token must never publish a tenant's
  // branches.
  if (ctx.env.BENTO_MODE !== "multi" && ctx.env.GITHUB_TOKEN) {
    return new GitHubTokenClient(ctx.env.GITHUB_TOKEN);
  }
  return undefined;
}

/** What a swarm starting from an existing branch is told about it. */
export interface BranchReview {
  repository: string;
  prNumber: number;
  url: string;
  title: string;
  base: string;
  isDraft: boolean;
  /** Unresolved threads, as written. Quoted by whoever puts them in a prompt. */
  threads: ReviewThread[];
}

/**
 * How many threads one branch contributes to a prompt.
 *
 * A pull request that has been argued over for a month can carry
 * hundreds, and a planner's opening prompt is not the place to find
 * that out. Twenty is what a person scrolling the Files tab would read
 * before they started skimming.
 */
const THREADS_PER_REPOSITORY = 20;

/**
 * Reads what is already being asked about a branch, in every
 * repository the project spans.
 *
 * This is the whole of "start from an existing branch and pick up its
 * review": a swarm that continues somebody's feature branch has a
 * pull request open on it, that pull request has comments nobody has
 * addressed, and the planner deciding what to do next needs them in
 * front of it rather than a note saying they exist.
 *
 * Read through the server's own GitHub connection, which is the only
 * kind there is: the credential stays here, and what reaches the
 * sandbox is the text. An agent never holds a token that could read
 * this itself.
 *
 * Failures are swallowed per repository and the swarm starts anyway.
 * A planner that was not told about the review is worse than one that
 * was, and a swarm that refuses to start because GitHub was slow is
 * worse than both. The branch is still the branch either way.
 */
export async function reviewForBranch(
  ctx: AppContext,
  organizationId: string | null,
  branch: string,
  repositories: { name: string; repoUrl: string | null }[],
  db?: Db,
): Promise<BranchReview[]> {
  const client = await githubConnectionFor(ctx, organizationId, db ?? ctx.db);
  if (!client?.pullRequestForBranch || !client.openReviewThreads) return [];

  const found: BranchReview[] = [];
  for (const repository of repositories) {
    const parsed = repository.repoUrl ? parseOwnerRepo(repository.repoUrl) : null;
    if (!parsed) continue;
    try {
      const pr = await client.pullRequestForBranch({ ...parsed, branch });
      if (!pr) continue;
      const threads = await client.openReviewThreads(
        { ...parsed, prNumber: pr.prNumber },
        THREADS_PER_REPOSITORY,
      );
      found.push({
        repository: repository.name,
        prNumber: pr.prNumber,
        url: pr.url,
        title: pr.title,
        base: pr.base,
        isDraft: pr.isDraft,
        threads,
      });
    } catch (err) {
      console.error(
        `could not read the review on ${branch} in ${repository.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return found;
}

/**
 * The owner and repository a stored url names, or null.
 *
 * Parsed as an identity and nothing else, the way publish.ts parses
 * one: the url on the row is where the pull request is, not a server
 * this code will be pointed at.
 */
function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}
