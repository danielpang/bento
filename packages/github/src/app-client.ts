import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type {
  CheckSummary,
  GitHubClient,
  GitHubPublisher,
  GitHubRepository,
  OpenPullRequest,
  PullRequestInput,
  PullRequestRef,
  ReviewThreadSummary,
} from "./client.js";

export interface AppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export type GitHubAppConfig = Omit<AppConfig, "installationId">;

/**
 * Server-side GitHub App. Installations are selected per organization,
 * never once for the whole Bento process.
 */
export class GitHubApp {
  private octokit: Octokit;

  constructor(private config: GitHubAppConfig) {
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: config,
    });
  }

  forInstallation(installationId: string): GitHubAppClient {
    return new GitHubAppClient({ ...this.config, installationId });
  }

  async installation(
    installationId: string,
  ): Promise<{ id: string; accountLogin: string; accountType: string }> {
    const response = await this.octokit.apps.getInstallation({ installation_id: installationNumber(installationId) });
    const account = response.data.account as { login?: string; name?: string; type?: string } | null;
    return {
      id: String(response.data.id),
      accountLogin: account?.login ?? account?.name ?? "GitHub account",
      accountType: account?.type ?? "Account",
    };
  }
}

interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: { isResolved: boolean }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes { isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

/**
 * The read and write operations, over any authenticated Octokit. The
 * app client and the token client differ only in how they authenticate,
 * so the calls themselves live here once.
 */
export async function reviewThreadsVia(octokit: Octokit, ref: PullRequestRef): Promise<ReviewThreadSummary> {
  let total = 0;
  let unresolved = 0;
  let cursor: string | null = null;

  for (;;) {
    const response: ReviewThreadsResponse = await octokit.graphql(REVIEW_THREADS_QUERY, {
      owner: ref.owner,
      repo: ref.repo,
      number: ref.prNumber,
      cursor,
    });
    const threads = response.repository?.pullRequest?.reviewThreads;
    if (!threads) break;
    for (const node of threads.nodes) {
      total += 1;
      if (!node.isResolved) unresolved += 1;
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) break;
  }

  return { total, unresolved };
}

export async function checksVia(octokit: Octokit, ref: PullRequestRef): Promise<CheckSummary> {
  const pr = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.prNumber,
  });
  const runs = await octokit.checks.listForRef({
    owner: ref.owner,
    repo: ref.repo,
    ref: pr.data.head.sha,
    per_page: 100,
  });
  return summarizeChecks(runs.data.check_runs);
}

export async function ensurePullRequestVia(octokit: Octokit, input: PullRequestInput): Promise<OpenPullRequest> {
  // Every stage of a card commits to the same branch, so this runs
  // once per stage and must find the pull request the first one
  // opened. GitHub would refuse a duplicate anyway, with an error
  // that reads like a failure rather than the no-op it is.
  const open = await octokit.pulls.list({
    owner: input.owner,
    repo: input.repo,
    head: `${input.owner}:${input.head}`,
    state: "open",
    per_page: 1,
  });
  const existing = open.data[0];
  if (existing) return { prNumber: existing.number, url: existing.html_url };

  const created = await octokit.pulls.create({
    owner: input.owner,
    repo: input.repo,
    head: input.head,
    base: input.base,
    title: input.title,
    body: input.body,
  });
  return { prNumber: created.data.number, url: created.data.html_url };
}

/** GitHub App backed client. Installation tokens are short lived and repo scoped. */
export class GitHubAppClient implements GitHubClient, GitHubPublisher {
  private octokit: Octokit;

  constructor(config: AppConfig) {
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      },
    });
  }

  reviewThreads(ref: PullRequestRef): Promise<ReviewThreadSummary> {
    return reviewThreadsVia(this.octokit, ref);
  }

  checks(ref: PullRequestRef): Promise<CheckSummary> {
    return checksVia(this.octokit, ref);
  }

  ensurePullRequest(input: PullRequestInput): Promise<OpenPullRequest> {
    return ensurePullRequestVia(this.octokit, input);
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    const rows = await this.octokit.paginate(this.octokit.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return rows.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      url: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
    }));
  }

  async pushToken(repositoryId?: number): Promise<string> {
    const auth = (await this.octokit.auth({
      type: "installation",
      ...(repositoryId !== undefined ? { repositoryIds: [repositoryId] } : {}),
    })) as { token: string };
    return auth.token;
  }
}

function installationNumber(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid GitHub installation id");
  return id;
}

export interface CheckRunLike {
  status: string;
  conclusion: string | null;
}

/** Exported for testing: maps check run states onto pass/pending/fail counts. */
export function summarizeChecks(runs: CheckRunLike[]): CheckSummary {
  let pending = 0;
  let failed = 0;
  for (const run of runs) {
    if (run.status !== "completed") {
      pending += 1;
      continue;
    }
    // neutral, success, and skipped are all acceptable outcomes.
    if (run.conclusion && !["success", "neutral", "skipped"].includes(run.conclusion)) {
      failed += 1;
    }
  }
  return { total: runs.length, pending, failed };
}

/** Parses "owner/repo" out of the common GitHub remote URL shapes. */
export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (!match || !match[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}
