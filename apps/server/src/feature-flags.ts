import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { user } from "@bento/db";
import type { AppContext } from "./context.js";
import { actor } from "./middleware/actor.js";

/**
 * Beta features are each person's own choice, `identity.user.beta_features`:
 * off until they turn it on in Settings, Account (or the desktop app's
 * launcher), in both modes. Nothing else turns beta on. Unfinished
 * product (Bento Swarm and the rest) checks it through the helpers here.
 */
export async function hasBetaFeatures(ctx: AppContext, userId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ betaFeatures: user.betaFeatures })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.betaFeatures === true;
}

/**
 * The acting user when they have beta features on, or null.
 *
 * Beta endpoints that someone without beta must not learn about treat
 * null as 404, the same convention as the access helpers. GET /api/flags
 * is the exception: the console has to hear "no" in order to hide the UI.
 */
export async function getBetaTester(ctx: AppContext, c: Context): Promise<{ userId: string } | null> {
  const userId = actor(c);
  return (await hasBetaFeatures(ctx, userId)) ? { userId } : null;
}

/**
 * Whether unfinished product is on for one agent run.
 *
 * A run has no session and not always a person: the console and the
 * API start one as somebody, the gate evaluator and the schedules
 * start one as nobody. So it asks about the acting member when there
 * is one, and about the project's owner when there is not. It is their
 * board either way, so auto-started stages behave the same as the runs
 * they start by hand.
 */
export async function isBetaRun(
  ctx: AppContext,
  input: { actingUserId: string | null; projectOwnerId: string },
): Promise<boolean> {
  return hasBetaFeatures(ctx, input.actingUserId ?? input.projectOwnerId);
}

/**
 * Runs as a caller may read them. Which provider ran a run is Bento's
 * business and not the card's: the console shows it to beta testers
 * only, and the field is dropped here for everyone else, so the API is
 * not a way around the console.
 */
export async function runsForCaller<T extends { sandboxProvider?: string | null; sandboxExecution?: unknown }>(
  ctx: AppContext,
  c: Context,
  runs: T[],
): Promise<T[]> {
  if (runs.length === 0) return runs;
  const beta = await getBetaTester(ctx, c);
  // Native process identity is recovery bookkeeping, not part of the run API.
  // In particular its nested provider must not bypass the beta-only field.
  return runs.map(({ sandboxExecution: _execution, ...run }) => {
    if (beta) return run as T;
    const { sandboxProvider: _provider, ...rest } = run;
    return rest as T;
  });
}
