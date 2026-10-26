import type { Context } from "hono";
import { getActiveOrganizationMembership } from "../../access.js";
import type { AppContext } from "../../context.js";
import { githubConnectionFor } from "../../github.js";
import { requestSwarmAccess } from "../../swarm-access.js";
import { parseRepoUrl } from "@bento/github";

/**
 * Why a swarm request is refused, as the status and body the route
 * sends. The order they are asked in is the point: see requireSwarms
 * and requireSwarmCompute.
 */
export type SwarmRefusal =
  | { status: 403; body: { error: string; code: "SWARM_WAITLIST" } }
  | { status: 503; body: { error: string; code: "SWARM_ACCESS_UNAVAILABLE" } }
  | { status: 402; body: { error: string; message: string; code: "PLAN_LIMIT" } }
  | { status: 409; body: { error: string; code: "SWARM_GITHUB_REQUIRED" } };

/**
 * The door every swarm route goes through: the plan, answered as 402
 * with PLAN_LIMIT, which the console renders as the subscribe message.
 * Null means allowed. Reading, stopping and deleting a swarm ask only
 * this, so they never wait on PostHog and a person taken off the
 * waitlist flag can still stop what they started.
 *
 * Local mode registers no entitlements module, so nothing refuses
 * there. A multi mode install without a billing module reaches the
 * same place through the optional method being absent.
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
  if (!canUseSwarms) return null;
  const organization =
    organizationId === undefined ? (await getActiveOrganizationMembership(ctx, c))?.organizationId ?? null : organizationId;
  // Nothing to charge and nobody to charge it to: plans are per team.
  const refusal = organization ? await canUseSwarms.call(ctx.entitlements, organization) : null;
  // message and error carry the same sentence, because the console
  // reads one and the older clients read the other.
  return refusal ? { status: 402, body: { error: refusal.reason, message: refusal.reason, code: "PLAN_LIMIT" } } : null;
}

/**
 * The door for the routes that start agents (create, start, reopen, a
 * message, a retry, a split): the plan, then the hosted waitlist (see
 * swarmAccessFor), answered as 403 with SWARM_WAITLIST, or 503 when the
 * flag could not be read. Only these spend sandbox time, so only these
 * ask PostHog, and `warmSwarmAccess` asks before the tenant
 * transaction opens.
 */
export async function requireSwarmCompute(
  ctx: AppContext,
  c: Context,
  organizationId?: string | null,
): Promise<SwarmRefusal | null> {
  const plan = await requireSwarms(ctx, c, organizationId);
  if (plan) return plan;
  const access = await requestSwarmAccess(ctx, c);
  if (access === "waitlist") {
    return { status: 403, body: { error: "swarms are waitlisted on this server", code: "SWARM_WAITLIST" } };
  }
  if (access === "unavailable") {
    return { status: 503, body: { error: "swarm access could not be checked, try again", code: "SWARM_ACCESS_UNAVAILABLE" } };
  }
  /*
   * On a clone driver the swarm's machine is the only copy of its work
   * until it is pushed, and the reap keeps a machine until it is. With no
   * GitHub connection nothing is ever pushed, so the work has nowhere to
   * go and the machine would bill forever. A host driver's work stays in
   * the host's checkout and needs no remote.
   */
  if (ctx.drivers.default.workspace === "clone" && !(await githubConnectionFor(ctx, organizationId ?? null))) {
    return { status: 409, body: { error: SWARM_GITHUB_REQUIRED, code: "SWARM_GITHUB_REQUIRED" } };
  }
  return null;
}

export const SWARM_GITHUB_REQUIRED = "Connect GitHub under Settings, GitHub to run swarms.";

/**
 * The repositories a hosted swarm could not save its work to: one with
 * no GitHub remote has nowhere for the swarm's branch to go.
 */
export function swarmRepositoriesWithoutRemote(
  ctx: AppContext,
  repos: { name: string; repoUrl: string | null }[],
): string[] {
  if (ctx.drivers.default.workspace !== "clone") return [];
  return repos.filter((repo) => !repo.repoUrl || !parseRepoUrl(repo.repoUrl)).map((repo) => repo.name);
}
