import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack's own replay window. Older deliveries are dropped. */
const MAX_AGE_SEC = 60 * 5;

/**
 * Verifies Slack's v0 signing secret. Constant time compare so the
 * check cannot be probed byte by byte. Also rejects stale timestamps
 * so a captured request cannot be replayed later.
 */
export function verifySlackSignature(
  secret: string,
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > MAX_AGE_SEC) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The title of a card, with the bot mention stripped. */
export function mentionTitle(text: string, botUserId: string): string {
  const mention = new RegExp(`<@${botUserId}(?:\\|[^>]+)?>`, "g");
  return text.replace(mention, "").replace(/\s+/g, " ").trim();
}

/** Slack section text tops out at 3000 characters. */
export const SLACK_TEXT_LIMIT = 3000;

/**
 * Cuts a stage write-up down to something Slack will accept, at a
 * word boundary, and says so rather than stopping mid sentence.
 */
export function truncateWriteUp(text: string, limit: number = SLACK_TEXT_LIMIT - 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit).replace(/\s+\S*$/, "");
  return `${cut}\n\n(truncated. Open the card to read the rest.)`;
}

/**
 * A few Markdown habits turned into Slack mrkdwn. Agent write-ups are
 * Markdown; Slack is not. This is display only: the card still holds
 * the original.
 */
export function markdownToMrkdwn(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
    .replace(/^>\s?/gm, "> ");
}
