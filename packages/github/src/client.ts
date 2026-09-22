export interface ReviewThreadSummary {
  total: number;
  unresolved: number;
}

/**
 * One unresolved review thread, with enough of it to act on.
 *
 * The counts above are what a gate needs: a number to compare against
 * zero. This is what an agent needs, which is a different thing
 * entirely. A swarm asked to address the review comments has to know
 * which file, which line, and what was actually said, so the comments
 * travel as written.
 *
 * Every string here is written by somebody outside Bento, on a public
 * pull request in many cases, so it is untrusted input in the strict
 * sense: whatever reads it quotes it before it reaches a model.
 */
export interface ReviewThread {
  /** The file the thread is on, or null for one on the pull request itself. */
  path: string | null;
  /** The line in the current diff, when GitHub still knows it. */
  line: number | null;
  /** True when the thread is on a line the branch has since changed. */
  outdated: boolean;
  /** The comments, oldest first: who said it and what they said. */
  comments: { author: string | null; body: string }[];
}

/** One open pull request on a branch, as a swarm starting from it reads it. */
export interface OpenPullRequestOnBranch {
  prNumber: number;
  url: string;
  title: string;
  body: string | null;
  base: string;
  isDraft: boolean;
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
  /**
   * The unresolved threads themselves, rather than a count of them.
   *
   * Optional so the many stubs of the two gate reads stay valid; both
   * real clients implement it. Capped by the caller, because a pull
   * request that has been argued over for a month has more review
   * than any prompt should carry.
   */
  openReviewThreads?(ref: PullRequestRef, limit?: number): Promise<ReviewThread[]>;
  /**
   * The pull request open on one branch, when there is one. Optional
   * for the reason above.
   */
  pullRequestForBranch?(input: { owner: string; repo: string; branch: string }): Promise<OpenPullRequestOnBranch | null>;
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
  /** When true, opens a draft pull request. Ignored when one is already open. */
  draft?: boolean;
}

export interface OpenPullRequest {
  prNumber: number;
  url: string;
}

export interface PullRequestDetails {
  title: string;
  body: string | null;
  /** GitHub's own word: "open" or "closed". A merged one is closed. */
  state: string;
  /**
   * True only when GitHub says the branch was merged. A pull request
   * someone closed without merging is closed and not merged, and the
   * card's work is still unlanded, so the two are never conflated.
   */
  merged: boolean;
}

export interface PullRequestUpdateInput extends PullRequestRef {
  title?: string;
  body?: string;
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
  getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails>;
  updatePullRequest(input: PullRequestUpdateInput): Promise<void>;
  /** True when a comment containing the marker is already on the pull request. */
  pullRequestHasComment(ref: PullRequestRef, marker: string): Promise<boolean>;
  createPullRequestComment(ref: PullRequestRef, body: string): Promise<void>;
  /**
   * A short lived credential for pushing. Stays on the server and, when
   * GitHub supports narrowing the installation token, is limited to the
   * one repository about to be updated.
   */
  pushToken(repositoryId?: number): Promise<string>;
}
