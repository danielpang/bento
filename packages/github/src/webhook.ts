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
