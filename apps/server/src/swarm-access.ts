import { and, eq } from "drizzle-orm";
import { account, user } from "@bento/db";
import type { AppContext } from "./context.js";

/**
 * The PostHog flag that lets a person run swarms on Bento's own
 * sandboxes. Its release conditions match the person properties
 * `email` or `github_username`, so a person is let in by adding either
 * to the flag.
 */
export const HOSTED_SWARMS_FLAG = "hosted-swarms";

export type SwarmAccessState = "open" | "waitlist";

const ACCESS_TTL_MS = 60_000;
const LOGIN_TTL_MS = 60 * 60_000;
const answers = new Map<string, { state: SwarmAccessState; at: number }>();
const logins = new Map<string, { login: string | null; at: number }>();

/** Drops every cached answer, so a test can change what PostHog says. */
export function forgetSwarmAccess(): void {
  answers.clear();
  logins.clear();
}

/**
 * Whether this person may run swarms, or is shown the waitlist.
 *
 * Local Bento runs swarms on the person's own machine, so it is always
 * open. A hosted server asks PostHog, because every swarm there runs on
 * sandboxes Bento pays for. A server with no PostHog key is somebody's
 * own install on their own sandboxes, and is open too. A flag PostHog
 * could not answer is the waitlist.
 */
export async function swarmAccessFor(ctx: AppContext, userId: string): Promise<SwarmAccessState> {
  if (ctx.env.BENTO_MODE !== "multi") return "open";
  const isFeatureEnabled = ctx.analytics?.isFeatureEnabled;
  if (!isFeatureEnabled) return "open";

  const cached = answers.get(userId);
  if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached.state;

  let state: SwarmAccessState = "waitlist";
  const [person] = await ctx.db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  const login = await githubLogin(ctx, userId);
  const properties: Record<string, string> = {};
  if (person?.email) properties.email = person.email;
  if (login) properties.github_username = login;
  try {
    const enabled = await isFeatureEnabled.call(ctx.analytics, HOSTED_SWARMS_FLAG, userId, properties);
    if (enabled) state = "open";
  } catch (err) {
    console.warn(`[swarms] ${HOSTED_SWARMS_FLAG} could not be evaluated for user ${userId}:`, err);
  }
  answers.set(userId, { state, at: Date.now() });
  return state;
}

/**
 * The person's GitHub username, read from GitHub with their own linked
 * token, because sign in stores only the numeric account id. Null when
 * they never linked GitHub or GitHub would not say.
 */
export async function githubLogin(ctx: AppContext, userId: string): Promise<string | null> {
  const cached = logins.get(userId);
  if (cached && Date.now() - cached.at < LOGIN_TTL_MS) return cached.login;

  const [row] = await ctx.db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  if (!row?.accessToken) return null;

  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${row.accessToken}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[github] /user answered ${response.status} for user ${userId}`);
      return null;
    }
    const body = (await response.json()) as { login?: string };
    const login = body.login?.trim() || null;
    logins.set(userId, { login, at: Date.now() });
    return login;
  } catch (err) {
    console.warn(`[github] /user failed for user ${userId}:`, err);
    return null;
  }
}
