import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { betaFeaturesState, getBetaTester } from "../feature-flags.js";
import { actorMiddleware } from "../middleware/actor.js";

/**
 * Whether the acting user has beta features on, so the console can show
 * or hide unfinished UI, and on a hosted server the switch behind it
 * (`betaFeatures`: theirs, and whether their open team allows it) for
 * the Beta features card.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check.
 */
export function flagRoutes(ctx: AppContext) {
  return new Hono()
    .use("*", actorMiddleware(ctx))
    .get("/", async (c) => {
      const betaFeatures = await betaFeaturesState(ctx, c);
      return c.json({ betaTesters: (await getBetaTester(ctx, c)) !== null, ...(betaFeatures ? { betaFeatures } : {}) });
    });
}
