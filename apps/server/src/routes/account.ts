import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { user } from "@bento/db";
import type { AppContext } from "../context.js";
import { betaByChoice, isBetaPerson } from "../feature-flags.js";
import { forgetBetaDecision } from "../mcp/connections.js";
import { actor } from "../middleware/actor.js";
import { tenantDb as db } from "../middleware/tenant.js";

const patchOnboarding = z.object({ walkthrough: z.boolean() });
const patchMascots = z.object({ show: z.boolean() });
const patchBeta = z.object({ enabled: z.boolean() });

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
    })
    /** Whether the board's mascots come out. */
    .get("/mascots", async (c) => {
      const [row] = await db(c, ctx)
        .select({ show: user.boardMascots })
        .from(user)
        .where(eq(user.id, actor(c)))
        .limit(1);
      return c.json({ show: row?.show ?? false });
    })
    /** Off when they are dismissed on the board; on again from Settings, Account. */
    .patch("/mascots", zValidator("json", patchMascots), async (c) => {
      const { show } = c.req.valid("json");
      const [row] = await db(c, ctx)
        .update(user)
        .set({ boardMascots: show, updatedAt: new Date() })
        .where(eq(user.id, actor(c)))
        .returning({ show: user.boardMascots });
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ show: row.show });
    })
    /**
     * Whether this person chose to try beta features. `enabled` is the
     * switch as they set it: in local mode it is on until they turn it
     * off, in multi mode only once they turn it on, because off there
     * leaves the beta-testers flag to decide. `betaTesters` is the
     * answer every beta check gives them, which a person on the flag
     * sees as on with the switch off.
     */
    .get("/beta", async (c) => {
      const choice = await betaChoice(ctx, c);
      return c.json(await betaState(ctx, c, choice));
    })
    /** The switch alone, as one `beta|on` or `beta|off` line, for the Mac app. */
    .get("/beta/plain", async (c) => {
      const choice = await betaChoice(ctx, c);
      return c.text(betaSwitch(ctx, choice) ? "beta|on" : "beta|off");
    })
    .patch("/beta", zValidator("json", patchBeta), async (c) => {
      const { enabled } = c.req.valid("json");
      const [row] = await db(c, ctx)
        .update(user)
        .set({ betaFeatures: enabled, updatedAt: new Date() })
        .where(eq(user.id, actor(c)))
        .returning({ betaFeatures: user.betaFeatures, email: user.email });
      if (!row) return c.json({ error: "not found" }, 404);
      // The MCP gateway caches the decision per owner for a minute.
      forgetBetaDecision(actor(c));
      return c.json(await betaState(ctx, c, row));
    });
}

async function betaChoice(
  ctx: AppContext,
  c: Context,
): Promise<{ betaFeatures: boolean | null; email: string | null }> {
  const [row] = await db(c, ctx)
    .select({ betaFeatures: user.betaFeatures, email: user.email })
    .from(user)
    .where(eq(user.id, actor(c)))
    .limit(1);
  return { betaFeatures: row?.betaFeatures ?? null, email: row?.email ?? null };
}

/** The switch: the choice as it reads in this mode, with "not chosen" filled in. */
function betaSwitch(ctx: AppContext, choice: { betaFeatures: boolean | null }): boolean {
  return betaByChoice(ctx.env.BENTO_MODE !== "multi", choice.betaFeatures) === true;
}

async function betaState(
  ctx: AppContext,
  c: Context,
  choice: { betaFeatures: boolean | null; email: string | null },
): Promise<{ enabled: boolean; betaTesters: boolean }> {
  return {
    enabled: betaSwitch(ctx, choice),
    betaTesters: await isBetaPerson(ctx, actor(c), choice),
  };
}
