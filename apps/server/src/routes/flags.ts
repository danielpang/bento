import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { user } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor, actorMiddleware } from "../middleware/actor.js";

/**
 * The acting user's permanent feature flags.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check. The email is looked up rather
 * than taken from the client, so a request cannot claim to be a
 * different person in PostHog.
 *
 * Mounted outside the tenant transaction: evaluation waits on PostHog,
 * and holding a pooled connection for that round trip is the same
 * class of problem the SSE streams are excluded for.
 */
export function flagRoutes(ctx: AppContext) {
  return new Hono()
    .use("*", actorMiddleware(ctx))
    .get("/", async (c) => {
      const userId = actor(c);
      const [row] = await ctx.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      if (ctx.featureFlags) {
        return c.json(await ctx.featureFlags.snapshot(userId, { email: row?.email ?? null }));
      }
      return c.json({ betaTesters: ctx.env.BENTO_MODE !== "multi" });
    });
}
