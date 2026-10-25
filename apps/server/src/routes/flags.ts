import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { user } from "@bento/db";
import type { AppContext } from "../context.js";
import { betaFeaturesState, getBetaTester } from "../feature-flags.js";
import { actor, actorMiddleware } from "../middleware/actor.js";
import { swarmAccessFor } from "../swarm-access.js";

/**
 * Whether the acting user has beta features on, so the console can show
 * or hide unfinished UI, and on a hosted server the switch behind it
 * (`betaFeatures`: theirs, and whether their open team allows it) for
 * the Beta features card, and whether swarms open or show the waitlist.
 *
 * No entity and no tenant data, so there is no access helper here; the
 * actor middleware is the whole check.
 */
export function flagRoutes(ctx: AppContext) {
  return new Hono()
    .use("*", actorMiddleware(ctx))
    .get("/", async (c) => {
      const [betaFeatures, beta, swarms, waitlist] = await Promise.all([
        betaFeaturesState(ctx, c),
        getBetaTester(ctx, c),
        swarmAccessFor(ctx, actor(c)),
        ctx.db.select({ at: user.swarmWaitlistRequestedAt }).from(user).where(eq(user.id, actor(c))).limit(1),
      ]);
      return c.json({
        betaTesters: beta !== null,
        swarms,
        ...(swarms === "waitlist" ? { swarmWaitlistJoined: Boolean(waitlist[0]?.at) } : {}),
        ...(betaFeatures ? { betaFeatures } : {}),
      });
    });
}
