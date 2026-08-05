import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_AGE_MS = 60_000;

/**
 * Verifies Linear's Linear-Signature header: an HMAC-SHA256 hex digest of
 * the raw request body. Constant time compare so the check cannot be
 * probed byte by byte. Also rejects stale deliveries via the payload's
 * webhookTimestamp, per Linear's replay guidance.
 */
export function verifyLinearWebhookSignature(
  secret: string,
  body: string,
  signature: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  try {
    const payload = JSON.parse(body) as { webhookTimestamp?: number };
    if (typeof payload.webhookTimestamp === "number") {
      return Math.abs(now - payload.webhookTimestamp) <= MAX_WEBHOOK_AGE_MS;
    }
  } catch {
    return false;
  }
  return true;
}

export interface LinearWebhookIssue {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  updatedAt?: string;
  teamId?: string;
  state?: { id: string; name: string; type: string };
  labels?: { id: string; name: string }[];
}

export interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: string;
  data: LinearWebhookIssue;
  webhookTimestamp?: number;
}

/** Narrow a parsed webhook body down to an Issue event, or null. */
export function parseIssueWebhook(payload: unknown): LinearWebhookPayload | null {
  const p = payload as Partial<LinearWebhookPayload> | null;
  if (!p || p.type !== "Issue" || !p.data || typeof p.data.id !== "string") return null;
  if (p.action !== "create" && p.action !== "update" && p.action !== "remove") return null;
  return p as LinearWebhookPayload;
}
