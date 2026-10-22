import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { member, organization, user } from "@bento/db";
import { getActiveOrganizationMembership } from "./access.js";
import type { AppContext } from "./context.js";
import { actor } from "./middleware/actor.js";

/**
 * Whether beta features (Bento Swarm and the rest) are on.
 *
 * Local mode: the server's own startup flag, `BENTO_BETA_FEATURES`, which
 * the desktop launcher's checkbox sets. Nothing in the database decides
 * it, so it can only change by restarting local Bento.
 *
 * Multi mode: both a team that allows beta (`identity.organization.
 * beta_features_allowed`, an owner or admin's setting) and the person's
 * own switch (`identity.user.beta_features`). The team asked about is
 * the one the work belongs to; work outside any team is never beta.
 */
export async function hasBetaFeatures(ctx: AppContext, userId: string, organizationId: string | null): Promise<boolean> {
  if (ctx.env.BENTO_MODE !== "multi") return ctx.env.BENTO_BETA_FEATURES === true;
  if (!organizationId) return false;
  const [row] = await ctx.db
    .select({ allowed: organization.betaFeaturesAllowed, chosen: user.betaFeatures })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);
  return row?.allowed === true && row.chosen === true;
}

/**
 * The person's switch and whether the team they have open allows it,
 * for the console's Beta features card. Local mode has no switch.
 */
export async function betaFeaturesState(
  ctx: AppContext,
  c: Context,
): Promise<{ enabled: boolean; allowed: boolean } | null> {
  if (ctx.env.BENTO_MODE !== "multi") return null;
  const membership = await getActiveOrganizationMembership(ctx, c);
  const [row] = await ctx.db.select({ enabled: user.betaFeatures }).from(user).where(eq(user.id, actor(c))).limit(1);
  let allowed = false;
  if (membership) {
    const [team] = await ctx.db
      .select({ allowed: organization.betaFeaturesAllowed })
      .from(organization)
      .where(eq(organization.id, membership.organizationId))
      .limit(1);
    allowed = team?.allowed === true;
  }
  return { enabled: row?.enabled === true, allowed };
}

/**
 * The acting user when beta features are on for them in the team they
 * have open, or null.
 *
 * Beta endpoints that someone without beta must not learn about treat
 * null as 404, the same convention as the access helpers. GET /api/flags
 * is the exception: the console has to hear "no" in order to hide the UI.
 */
export async function getBetaTester(ctx: AppContext, c: Context): Promise<{ userId: string } | null> {
  const userId = actor(c);
  const membership = await getActiveOrganizationMembership(ctx, c);
  return (await hasBetaFeatures(ctx, userId, membership?.organizationId ?? null)) ? { userId } : null;
}

/**
 * Whether unfinished product is on for one agent run.
 *
 * A run has no session and not always a person: the console and the
 * API start one as somebody, the gate evaluator and the schedules
 * start one as nobody. So it asks about the acting member when there
 * is one, and about the project's owner when there is not, in the
 * project's own team. It is their board either way, so auto-started
 * stages behave the same as the runs they start by hand.
 */
export async function isBetaRun(
  ctx: AppContext,
  input: { actingUserId: string | null; projectOwnerId: string; organizationId: string | null },
): Promise<boolean> {
  return hasBetaFeatures(ctx, input.actingUserId ?? input.projectOwnerId, input.organizationId);
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
