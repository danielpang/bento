import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../context.js";

export const ACTOR_KEY = "bentoUserId";
export const ORG_KEY = "bentoOrgId";

/**
 * Resolves who is making the request, and which organization they are
 * acting in.
 *
 * Local mode: always the auto-provisioned local user, no sign in, no org.
 * Multi mode: the better-auth session, from either the session cookie
 * (browser) or a bearer token (Mac app, TUI). Unauthenticated requests
 * are rejected; health and the auth routes are mounted outside this
 * middleware.
 */
export function actorMiddleware(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    if (ctx.env.BENTO_MODE !== "multi" || !ctx.auth) {
      c.set(ACTOR_KEY, ctx.userId);
      c.set(ORG_KEY, null);
      return next();
    }

    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) {
      return c.json({ error: "sign in required" }, 401);
    }
    c.set(ACTOR_KEY, session.user.id);
    // activeOrganizationId is set by the organization plugin when the
    // user switches orgs. Null means they have not picked one yet.
    c.set(ORG_KEY, (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null);
    return next();
  };
}

/** The acting user for this request. */
export function actor(c: Context): string {
  const userId = c.get(ACTOR_KEY) as string | undefined;
  if (!userId) throw new Error("actor middleware did not run");
  return userId;
}

/** The organization this request acts in, or null in local mode. */
export function activeOrg(c: Context): string | null {
  return (c.get(ORG_KEY) as string | null | undefined) ?? null;
}
