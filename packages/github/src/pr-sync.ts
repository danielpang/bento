import type { Octokit } from "@octokit/rest";
import type { PullRequestDetails, PullRequestRef, PullRequestUpdateInput } from "./client.js";

/**
 * Hidden marker naming what a comment was posted for, so a retry does
 * not post it twice. The id is whatever record the caller is applying:
 * a pull_request_updates row, say.
 */
export function pullRequestMarker(id: string): string {
  return `<!-- bento-pr-update:${id} -->`;
}

export async function getPullRequestVia(octokit: Octokit, ref: PullRequestRef): Promise<PullRequestDetails> {
  const pr = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.prNumber,
  });
  return {
    title: pr.data.title,
    body: pr.data.body,
    state: pr.data.state,
    merged: pr.data.merged === true,
  };
}

export async function updatePullRequestVia(octokit: Octokit, input: PullRequestUpdateInput): Promise<void> {
  await octokit.pulls.update({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
}

export async function pullRequestHasCommentVia(
  octokit: Octokit,
  ref: PullRequestRef,
  marker: string,
): Promise<boolean> {
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.prNumber,
    per_page: 100,
  });
  return comments.some((comment) => comment.body?.includes(marker));
}

export async function createPullRequestCommentVia(
  octokit: Octokit,
  ref: PullRequestRef,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.prNumber,
    body,
  });
}
