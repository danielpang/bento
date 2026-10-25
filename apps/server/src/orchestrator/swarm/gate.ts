import type { Context } from "hono";
import { getActiveOrganizationMembership } from "../../access.js";
import type { AppContext } from "../../context.js";
import { actor } from "../../middleware/actor.js";
import { swarmAccessFor } from "../../swarm-access.js";

/**
 * Why a swarm request is refused, as the status and body the route
 * sends. Two different answers, and the order they are asked in is the
 * point: see requireSwarms.
 */
export type SwarmRefusal =
  | { status: 403; body: { error: string; code: "SWARM_WAITLIST" } }
  | { status: 402; body: { error: string; message: string; code: "PLAN_LIMIT" } };

/**
 * The door every swarm route goes through. Null means allowed.
 *
 * Two gates, in this order and never the other way round:
 *
 * 1. The plan, answered as 402 with PLAN_LIMIT, which is the code the
 *    console already knows how to render. Swarms need a subscription.
 * 2. The waitlist (see swarmAccessFor), answered as 403 with
 *    SWARM_WAITLIST: on a hosted server only people let in through
 *    PostHog run swarms on Bento's sandboxes, and the console offers
 *    the waitlist only to a team whose plan includes swarms. Everyone
 *    sees the Swarms tab, so there is nothing to hide behind a 404.
 *
 * Local mode registers no entitlements module and has no waitlist, so
 * nothing refuses there. A multi mode install without a billing module reaches
 * the same place through the optional method being absent.
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
  const canUseSwarms = ctx.entitlements?.canUseSwarms;
  if (canUseSwarms) {
    const organization =
      organizationId === undefined ? (await getActiveOrganizationMembership(ctx, c))?.organizationId ?? null : organizationId;
    // Nothing to charge and nobody to charge it to: plans are per team.
    const refusal = organization ? await canUseSwarms.call(ctx.entitlements, organization) : null;
    // message and error carry the same sentence, because the console
    // reads one and the older clients read the other.
    if (refusal) return { status: 402, body: { error: refusal.reason, message: refusal.reason, code: "PLAN_LIMIT" } };
  }
  if ((await swarmAccessFor(ctx, actor(c))) === "waitlist") {
    return { status: 403, body: { error: "swarms are waitlisted on this server", code: "SWARM_WAITLIST" } };
  }
  return null;
}
