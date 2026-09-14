import { Octokit } from "@octokit/rest";
import { checksVia, ensurePullRequestVia, mergeStateVia, reviewThreadsVia } from "./app-client.js";
import type {
  CheckSummary,
  CommitFilesInput,
  GitHubClient,
  GitHubPublisher,
  GitHubRepositoryFiles,
  MergeStateSummary,
  OpenPullRequest,
  PullRequestDetails,
  PullRequestInput,
  PullRequestRef,
  PullRequestUpdateInput,
  ReviewThreadSummary,
} from "./client.js";
import {
  createPullRequestCommentVia,
  getPullRequestVia,
  pullRequestHasRunCommentVia,
  updatePullRequestVia,
} from "./pr-sync.js";
import { commitFilesVia, readFileVia } from "./repo-files.js";

/**
 * A personal access token instead of a GitHub App.
 *
 * This is the self-hoster's path: local mode and small deployments have
 * no App to install, but a fine grained token with contents and pull
 * request access on the repositories that matter does the same work.
 * The token is broader than an installation token and never expires on
 * its own, so it stays on the server exactly like the App credential:
 * pushes happen on the trusted host, and nothing here is ever mounted
 * into a sandbox.
 */
export class GitHubTokenClient implements GitHubClient, GitHubPublisher, GitHubRepositoryFiles {
  private octokit: Octokit;

  constructor(private token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  reviewThreads(ref: PullRequestRef): Promise<ReviewThreadSummary> {
    return reviewThreadsVia(this.octokit, ref);
  }

  checks(ref: PullRequestRef): Promise<CheckSummary> {
    return checksVia(this.octokit, ref);
  }

  mergeState(ref: PullRequestRef): Promise<MergeStateSummary> {
    return mergeStateVia(this.octokit, ref);
  }

  ensurePullRequest(input: PullRequestInput): Promise<OpenPullRequest> {
    return ensurePullRequestVia(this.octokit, input);
  }

  getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails> {
    return getPullRequestVia(this.octokit, ref);
  }

  updatePullRequest(input: PullRequestUpdateInput): Promise<void> {
    return updatePullRequestVia(this.octokit, input);
  }

  pullRequestHasRunComment(ref: PullRequestRef, runId: string): Promise<boolean> {
    return pullRequestHasRunCommentVia(this.octokit, ref, runId);
  }

  createPullRequestComment(ref: PullRequestRef, body: string): Promise<void> {
    return createPullRequestCommentVia(this.octokit, ref, body);
  }

  readFile(input: { owner: string; repo: string; path: string; ref: string }): Promise<string | null> {
    return readFileVia(this.octokit, input);
  }

  commitFiles(input: CommitFilesInput): Promise<{ sha: string }> {
    return commitFilesVia(this.octokit, input);
  }

  /** The token itself: a PAT cannot be narrowed per push the way an installation token can. */
  async pushToken(): Promise<string> {
    return this.token;
  }
}
