import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { betaPerson, isBetaPerson } from "../feature-flags.js";
import { actor, actorMiddleware } from "../middleware/actor.js";

/**
 * The acting user's permanent feature flags.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check. The email is looked up rather
 * than taken from the client, so a request cannot claim to be a
 * different person in PostHog. The person's own beta choice is read
 * with it (`betaByChoice`).
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
      return c.json({ betaTesters: await isBetaPerson(ctx, userId, await betaPerson(ctx, userId)) });
    });
}
