import type { Octokit } from "@octokit/rest";
import type { PullRequestDetails, PullRequestRef, PullRequestUpdateInput } from "./client.js";

/** Hidden marker so a re-run or republish does not post the same comment twice. */
export function pullRequestRunMarker(runId: string): string {
  return `<!-- bento-run:${runId} -->`;
}

/** True when the body is still Bento's default or empty, so a sync may replace it. */
export function isBentoDefaultPullRequestBody(body: string | null | undefined): boolean {
  const text = body?.trim() ?? "";
  if (!text) return true;
  if (/^Opened by Bento for "/.test(text)) return true;
  return false;
}

/**
 * Optional title from a leading markdown H1; the rest becomes the body.
 * Agents are not required to use the heading; the whole file works as body.
 */
export function parseStageWriteUpForPullRequest(content: string): { title?: string; body: string } {
  const trimmed = content.trim();
  if (!trimmed) return { body: "" };
  const lines = trimmed.split("\n");
  const first = lines[0];
  if (first?.startsWith("# ")) {
    const title = first.slice(2).trim();
    const body = lines.slice(1).join("\n").trim();
    return title ? { title, body } : { body: trimmed };
  }
  return { body: trimmed };
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

export async function pullRequestHasRunCommentVia(
  octokit: Octokit,
  ref: PullRequestRef,
  runId: string,
): Promise<boolean> {
  const marker = pullRequestRunMarker(runId);
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
