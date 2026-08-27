export interface ReviewThreadSummary {
  total: number;
  unresolved: number;
}

export interface CheckSummary {
  total: number;
  pending: number;
  failed: number;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Whether a pull request can merge cleanly into its base.
 *
 * "unknown" is a real answer, not a failure: GitHub computes
 * mergeability lazily, so the first read after a push can come back
 * before the computation finishes. It also covers closed and merged
 * pull requests, which have nothing left to resolve. Callers treat it
 * as "not known to conflict" and ask again later rather than blocking
 * on it.
 */
export interface MergeStateSummary {
  state: "clean" | "conflicted" | "unknown";
}

/**
 * The GitHub surface the gate evaluators depend on. Kept narrow so gates
 * can be tested with a stub and so self-hosters without a GitHub App can
 * supply a token-based implementation instead.
 */
export interface GitHubClient {
  /** PR review threads. Resolution state is GraphQL-only; REST omits it. */
  reviewThreads(ref: PullRequestRef): Promise<ReviewThreadSummary>;
  /** Check runs on the PR head commit. */
  checks(ref: PullRequestRef): Promise<CheckSummary>;
  /**
   * Whether the pull request merges cleanly into its base. Optional so
   * the many test stubs of the two gate reads above stay valid; both
   * real clients implement it.
   */
  mergeState?(ref: PullRequestRef): Promise<MergeStateSummary>;
}

export interface PullRequestInput {
  owner: string;
  repo: string;
  /** Branch holding the work. */
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface OpenPullRequest {
  prNumber: number;
  url: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
}

/**
 * The write half: pushing a branch and opening its pull request.
 *
 * Separate from `GitHubClient` because the two have different callers
 * and different risks. Gates only ever read, and a self-hoster can
 * supply a read-only implementation without also having to implement
 * this. Nothing here is ever handed to a sandbox: an agent can read
 * anything its sandbox can, so a push credential inside one is a
 * credential one prompt injection away from being exfiltrated. The
 * agent commits, and the server pushes on its behalf.
 */
export interface GitHubPublisher {
  /**
   * Opens a pull request for the branch, or returns the one already
   * open for it. Every stage of a card pushes to the same branch, so
   * this is called repeatedly and must not open a second.
   */
  ensurePullRequest(input: PullRequestInput): Promise<OpenPullRequest>;
  /**
   * A short lived credential for pushing. Stays on the server and, when
   * GitHub supports narrowing the installation token, is limited to the
   * one repository about to be updated.
   */
  pushToken(repositoryId?: number): Promise<string>;
}
