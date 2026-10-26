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

/** GitHub refuses a pull request or comment body past 65536 characters. */
export const GITHUB_BODY_MAX_CHARS = 65536;
const TRUNCATED_NOTE = "\n\n(Cut short: the full text is longer than GitHub allows.)";

/** Cuts a body to what GitHub takes, keeping `tail` (a marker, say) whole at the end. */
export function fitPullRequestBody(body: string, tail = ""): string {
  if (body.length + tail.length <= GITHUB_BODY_MAX_CHARS) return body + tail;
  let end = GITHUB_BODY_MAX_CHARS - TRUNCATED_NOTE.length - tail.length;
  const last = body.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return body.slice(0, end) + TRUNCATED_NOTE + tail;
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
    ...(input.body !== undefined ? { body: fitPullRequestBody(input.body) } : {}),
  });
}

/** Takes a draft pull request out of draft. GitHub offers this only through GraphQL. */
export async function markPullRequestReadyVia(octokit: Octokit, ref: PullRequestRef): Promise<void> {
  const pr = await octokit.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: ref.prNumber });
  if (!pr.data.draft || pr.data.state !== "open") return;
  await octokit.graphql(
    "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
    { id: pr.data.node_id },
  );
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
    body: fitPullRequestBody(body),
  });
}
