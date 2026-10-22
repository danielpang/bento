import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { hasBetaFeatures } from "../feature-flags.js";
import { actor, actorMiddleware } from "../middleware/actor.js";

/**
 * Whether the acting user has beta features on, so the console can show
 * or hide unfinished UI.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check.
 */
export function flagRoutes(ctx: AppContext) {
  return new Hono()
    .use("*", actorMiddleware(ctx))
    .get("/", async (c) => {
      const userId = actor(c);
      return c.json({ betaTesters: await hasBetaFeatures(ctx, userId) });
    });
}
