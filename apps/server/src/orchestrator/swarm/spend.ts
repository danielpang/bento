import { and, eq, inArray, sql } from "drizzle-orm";
import { agentRuns, swarms } from "@bento/db";
import type { AppContext } from "../../context.js";

/**
 * Fired when a swarm finishes, with what it spent broken down by the
 * role that spent it and by how well the figure is known.
 *
 * The card board's counterpart is "agent stage spend", and this is
 * deliberately shaped like it: one event per finished unit of work,
 * with the figure as a property, so the dashboard sums `cost_usd`
 * rather than counting events.
 *
 * Two breakdowns rather than one total, because the two questions a
 * swarm actually raises are which role the money went to and how much
 * of the number is real. The first is the product's whole cost thesis:
 * a frontier planner with cheap workers is supposed to spend most of
 * its money on workers, and nothing anywhere else can say whether that
 * is what happened. The second is the honesty: a swarm whose spend is
 * mostly assumed has a total that is mostly a guess, and a dashboard
 * that added the tiers together would report the guess as a
 * measurement.
 *
 * A floor rather than a bill, like the stage event: the assumed tier
 * stands in for tools that report nothing, and the notional tier is a
 * list price a subscription had already paid for.
 */
export const AGENT_SWARM_SPEND_EVENT = "agent swarm spend";

/** Which door the swarm left by. The spend means something different in each. */
export type SwarmSpendOutcome = "done" | "cancelled" | "budget_exhausted" | "timed_out" | "failed";

/**
 * Records what a swarm cost, now that it is over.
 *
 * Awaited so the event is queued before the caller moves on, the same
 * reason the stage event is. Failures stay in a warning: a PostHog
 * outage must not fail a swarm that has already finished.
 */
export async function captureSwarmSpend(
  ctx: Pick<AppContext, "db" | "analytics">,
  swarmId: string,
  outcome: SwarmSpendOutcome,
): Promise<void> {
  const analytics = ctx.analytics;
  if (!analytics) return;
  try {
    const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarmId)).limit(1);
    if (!swarm) return;

    /*
     * Counted from the runs rather than from the swarm's four columns,
     * because the columns are totals and the question here is where
     * the money went. The columns are the authority for how much, and
     * they are sent too, so a dashboard that ever finds the two
     * disagreeing knows the rollup has drifted.
     */
    const rows = await ctx.db
      .select({
        role: agentRuns.role,
        tier: agentRuns.costTier,
        runs: sql<number>`count(*)::int`,
        costUsd: sql<string | null>`sum(${agentRuns.costUsd})`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.swarmId, swarmId), inArray(agentRuns.status, ["succeeded", "failed", "cancelled"])))
      .groupBy(agentRuns.role, agentRuns.costTier);

    const byRole: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    const runsByRole: Record<string, number> = {};
    let runs = 0;
    let untiered = 0;
    for (const row of rows) {
      const usd = row.costUsd === null ? 0 : Number(row.costUsd);
      byRole[row.role] = (byRole[row.role] ?? 0) + usd;
      runsByRole[row.role] = (runsByRole[row.role] ?? 0) + row.runs;
      runs += row.runs;
      // A run with no tier is one that ended before any of this
      // existed, or one nothing could work out. Counted apart rather
      // than folded into a tier it does not belong to.
      if (row.tier === null) untiered += row.runs;
      else byTier[row.tier] = (byTier[row.tier] ?? 0) + usd;
    }

    analytics.capture({
      event: AGENT_SWARM_SPEND_EVENT,
      userId: swarm.startedBy ?? null,
      organizationId: swarm.organizationId,
      properties: {
        swarm_id: swarm.id,
        project_id: swarm.projectId,
        template_id: swarm.templateId,
        outcome,
        /*
         * The three the budget counts, and the fourth it does not.
         * Kept apart here for the same reason they are kept apart
         * everywhere else: a sum of them would be one number standing
         * for a measurement, an estimate, a guess and a list price
         * somebody had already paid.
         */
        cost_usd: Number(swarm.spentMeasuredUsd) + Number(swarm.spentEstimatedUsd) + Number(swarm.spentAssumedUsd),
        measured_usd: Number(swarm.spentMeasuredUsd),
        estimated_usd: Number(swarm.spentEstimatedUsd),
        assumed_usd: Number(swarm.spentAssumedUsd),
        notional_usd: Number(swarm.spentNotionalUsd),
        budget_usd: swarm.budgetUsd === null ? null : Number(swarm.budgetUsd),
        by_role: byRole,
        by_tier: byTier,
        runs_by_role: runsByRole,
        run_count: runs,
        runs_without_tier: untiered,
        max_workers: swarm.maxWorkers,
      },
    });
  } catch (err) {
    console.warn(`could not record what swarm ${swarmId} spent:`, err);
    analytics.captureException(err, null, null, { swarm_id: swarmId, source: "swarm_spend" });
  }
}
