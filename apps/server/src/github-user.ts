import { and, eq } from "drizzle-orm";
import { account } from "@bento/db";
import type { AppContext } from "./context.js";

/** The OAuth token of the GitHub account this person linked, or null. */
export async function linkedGitHubToken(ctx: Pick<AppContext, "db">, userId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return row?.accessToken ?? null;
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
 * The person's GitHub username, read from GitHub with their own linked
 * token, because sign in stores only the numeric account id. Null when
 * they never linked GitHub or GitHub would not say.
 */
export async function githubLogin(ctx: Pick<AppContext, "db">, userId: string): Promise<string | null> {
  const token = await linkedGitHubToken(ctx, userId);
  if (!token) return null;
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: githubUserHeaders(token),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[github] /user answered ${response.status} for user ${userId}`);
      return null;
    }
    const body = (await response.json()) as { login?: string };
    return body.login?.trim() || null;
  } catch (err) {
    console.warn(`[github] /user failed for user ${userId}:`, err);
    return null;
  }
}
