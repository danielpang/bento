import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { user } from "@bento/db";
import type { AppContext } from "../context.js";
import { actor } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";

const patchOnboarding = z.object({ walkthrough: z.boolean() });

/**
 * Preferences that belong to the person signed in, in both modes.
 *
 * Keyed by the acting user and nothing else, so there is no entity to
 * resolve through an access helper: a request can only ever read or
 * change its own row. Local mode has its one provisioned user, which
 * is why this is not machine settings.
 */
export function accountRoutes(ctx: AppContext) {
  return new Hono()
    /** Whether the console should open the onboarding walkthrough. */
    .get("/onboarding", async (c) => {
      const [row] = await db(c, ctx)
        .select({ walkthrough: user.onboardingWalkthrough })
        .from(user)
        .where(eq(user.id, actor(c)))
        .limit(1);
      return c.json({ walkthrough: row?.walkthrough ?? false });
    })
    /** Off when it is skipped or finished; on again from Settings, Account. */
    .patch("/onboarding", zValidator("json", patchOnboarding), async (c) => {
      const { walkthrough } = c.req.valid("json");
      const [row] = await db(c, ctx)
        .update(user)
        .set({ onboardingWalkthrough: walkthrough, updatedAt: new Date() })
        .where(eq(user.id, actor(c)))
        .returning({ walkthrough: user.onboardingWalkthrough });
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ walkthrough: row.walkthrough });
    });
}
