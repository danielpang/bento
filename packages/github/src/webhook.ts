import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies GitHub's X-Hub-Signature-256 header. Constant time compare so
 * the check cannot be probed byte by byte.
 */
export function verifyWebhookSignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebhookTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

interface WebhookPayload {
  action?: string;
  number?: number;
  pull_request?: { number?: number };
  repository?: { name?: string; owner?: { login?: string } };
  check_suite?: { pull_requests?: { number?: number }[] };
}

/** Events that should trigger a gate re-evaluation, and the PR they concern. */
export function webhookTarget(event: string, payload: unknown): WebhookTarget | null {
  const p = payload as WebhookPayload;
  const owner = p.repository?.owner?.login;
  const repo = p.repository?.name;
  if (!owner || !repo) return null;

  if (event === "pull_request" || event === "pull_request_review" || event === "pull_request_review_thread") {
    const prNumber = p.pull_request?.number ?? p.number;
    if (prNumber) return { owner, repo, prNumber };
    return null;
  }
  if (event === "check_suite" || event === "check_run") {
    const prNumber = p.check_suite?.pull_requests?.[0]?.number;
    if (prNumber) return { owner, repo, prNumber };
    return null;
  }
  return null;
}

export interface PushTarget {
  owner: string;
  repo: string;
  /** The branch pushed to, without refs/heads/. */
  branch: string;
  /** Every path the pushed commits added, changed, or removed. */
  paths: Set<string>;
}

interface PushPayload {
  ref?: string;
  deleted?: boolean;
  repository?: { name?: string; owner?: { login?: string; name?: string } };
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
  head_commit?: { added?: string[]; modified?: string[]; removed?: string[] } | null;
}

/**
 * A push event, as the branch it landed on and the paths it touched.
 *
 * Only branch pushes count: a tag carries no branch to compare with,
 * and a deleted branch has nothing left to read. The paths come from
 * every commit in the push, so a file changed three commits back on a
 * five commit push is still seen. GitHub lists at most twenty commits
 * per push; a bigger push than that reports what it can, and the head
 * commit is always included.
 */
export function pushTarget(event: string, payload: unknown): PushTarget | null {
  if (event !== "push") return null;
  const p = payload as PushPayload;
  const owner = p.repository?.owner?.login ?? p.repository?.owner?.name;
  const repo = p.repository?.name;
  const ref = p.ref ?? "";
  if (!owner || !repo || !ref.startsWith("refs/heads/") || p.deleted) return null;
  const paths = new Set<string>();
  const commits = [...(p.commits ?? []), ...(p.head_commit ? [p.head_commit] : [])];
  for (const commit of commits) {
    for (const path of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
      paths.add(path);
    }
  }
  return { owner, repo, branch: ref.slice("refs/heads/".length), paths };
}
