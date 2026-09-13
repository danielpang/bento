import type { Context } from "hono";
import { getActiveOrganizationMembership } from "../../access.js";
import type { AppContext } from "../../context.js";
import { getBetaTester } from "../../feature-flags.js";

/**
 * Why a swarm request is refused, as the status and body the route
 * sends. Two different answers, and the order they are asked in is the
 * point: see requireSwarms.
 */
export type SwarmRefusal =
  | { status: 404; body: { error: string } }
  | { status: 402; body: { error: string; message: string; code: "PLAN_LIMIT" } };

/**
 * The door every swarm route goes through. Null means allowed.
 *
 * Two gates, in this order and never the other way round:
 *
 * 1. The beta-testers flag, answered as 404. A person who is not on the
 *    allowlist must not be able to tell that swarms exist, and a 402
 *    saying "your plan does not include swarms" would tell them. Same
 *    convention as the access helpers: not yours reads as not there.
 * 2. The plan, answered as 402 with PLAN_LIMIT, which is the code the
 *    console already knows how to render.
 *
 * Both collapse by construction where they should. Local mode has one
 * trusted user: the flag is always on, and no entitlements module is
 * registered, so nothing here refuses anything. A multi mode install
 * without a billing module reaches the same place through the optional
 * method being absent.
 */
export async function requireSwarms(
  ctx: AppContext,
  c: Context,
  /**
   * The organization to ask the plan about. Defaults to the session's
   * active organization, re-resolved against current membership. A
   * route that has already loaded an entity passes that entity's
   * organization instead, so the answer is about the team whose swarm
   * it is rather than the tab the caller happens to have open.
   */
  organizationId?: string | null,
): Promise<SwarmRefusal | null> {
  const tester = await getBetaTester(ctx, c);
  if (!tester) return { status: 404, body: { error: "not found" } };

  const canUseSwarms = ctx.entitlements?.canUseSwarms;
  if (!canUseSwarms) return null;

  const organization =
    organizationId === undefined ? (await getActiveOrganizationMembership(ctx, c))?.organizationId ?? null : organizationId;
  // Nothing to charge and nobody to charge it to: a personal project in
  // multi mode belongs to no organization, and plans are per team.
  if (!organization) return null;

  const refusal = await canUseSwarms.call(ctx.entitlements, organization);
  if (!refusal) return null;
  // message and error carry the same sentence, because the console
  // reads one and the older clients read the other.
  return { status: 402, body: { error: refusal.reason, message: refusal.reason, code: "PLAN_LIMIT" } };
}
