import { and, eq } from "drizzle-orm";
import { account } from "@bento/db";
import type { AppContext } from "./context.js";

/** The OAuth token of the GitHub account this person linked, or null. */
export async function linkedGitHubToken(ctx: Pick<AppContext, "db">, userId: string): Promise<string | null> {
  return (await linkedGitHubAccount(ctx, userId))?.token ?? null;
}

/** The GitHub account this person linked: its numeric id and token, or null. */
async function linkedGitHubAccount(
  ctx: Pick<AppContext, "db">,
  userId: string,
): Promise<{ id: string; token: string | null } | null> {
  const [row] = await ctx.db
    .select({ accountId: account.accountId, accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return row ? { id: row.accountId, token: row.accessToken } : null;
}

/** Headers for a GitHub API call made as the person. */
export function githubUserHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

/**
 * The person's GitHub username. Sign in stores only the numeric account
 * id, so it is read from GitHub: with the person's own token when it
 * still works, and otherwise from the public profile of that id, since
 * a token saved at sign in expires or is revoked long before the
 * account stops being theirs. Null when they never linked GitHub or
 * GitHub would not say.
 */
export async function githubLogin(ctx: Pick<AppContext, "db">, userId: string): Promise<string | null> {
  const linked = await linkedGitHubAccount(ctx, userId);
  if (!linked) return null;
  if (linked.token) {
    const login = await readLogin("https://api.github.com/user", githubUserHeaders(linked.token), userId);
    if (login) return login;
  }
  if (!/^\d+$/.test(linked.id)) return null;
  return readLogin(
    `https://api.github.com/user/${linked.id}`,
    { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    userId,
  );
}

async function readLogin(url: string, headers: Record<string, string>, userId: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      console.warn(`[github] ${new URL(url).pathname} answered ${response.status} for user ${userId}`);
      return null;
    }
    const body = (await response.json()) as { login?: string };
    return body.login?.trim() || null;
  } catch (err) {
    console.warn(`[github] ${new URL(url).pathname} failed for user ${userId}:`, err);
    return null;
  }
}
