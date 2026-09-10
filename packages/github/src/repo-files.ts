import type { Octokit } from "@octokit/rest";
import type { CommitFilesInput } from "./client.js";

/**
 * The file's text at a ref, or null when the path is missing or is not a
 * file. Anything else (auth, rate limit, network) is thrown, so a
 * caller can tell "there is no such file" from "GitHub could not say".
 */
export async function readFileVia(
  octokit: Octokit,
  input: { owner: string; repo: string; path: string; ref: string },
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      ref: input.ref,
    });
    const data = response.data as { type?: string; content?: string; encoding?: string };
    if (data.type !== "file" || typeof data.content !== "string") return null;
    if (data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    if (isStatus(err, 404)) return null;
    throw err;
  }
}

/**
 * Every file in one commit on a new branch, through the Git data API.
 *
 * Built from the base branch's current tree, so the commit carries the
 * rest of the repository untouched and a pull request from the branch
 * shows exactly these files as its diff. The branch is created at the
 * end, pointing at the new commit, so a failure part way leaves no
 * branch behind.
 */
export async function commitFilesVia(octokit: Octokit, input: CommitFilesInput): Promise<{ sha: string }> {
  const { owner, repo } = input;
  const base = await octokit.git.getRef({ owner, repo, ref: `heads/${input.baseBranch}` });
  const baseSha = base.data.object.sha;
  const baseCommit = await octokit.git.getCommit({ owner, repo, commit_sha: baseSha });

  const tree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
    tree: input.files.map((file) => ({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: file.content,
    })),
  });
  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message: input.message,
    tree: tree.data.sha,
    parents: [baseSha],
  });
  await octokit.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: commit.data.sha });
  return { sha: commit.data.sha };
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === status;
}
