import { and, desc, eq } from "drizzle-orm";
import { agentRuns, featureEvents, stages } from "@bento/db";
import type { AppContext } from "../context.js";

/**
 * Fired when a card leaves a stage, with the reported agent cost of
 * that visit. The PostHog dashboard sums `cost_usd`; counting the
 * events would report completions, not spend.
 *
 * A floor, not a bill: only some tools print a cost, and a run that
 * fails before finishing prints none. Re-entering a stage starts a new
 * visit, so a card sent back and completed again does not recount the
 * earlier runs.
 */
export const AGENT_STAGE_SPEND_EVENT = "agent stage spend";

export type StageSpendTrigger = "manual" | "gate_auto" | "linear_auto";

/**
 * Sums the figures the tools actually printed. Unreported rows stay in
 * `runCount` so a dashboard can tell a free visit from an unmeasured
 * one, but they add nothing to `costUsd`.
 */
export function tallyStageSpend(rows: Array<{ costUsd: string | number | null }>): {
  costUsd: number;
  runCount: number;
  runsWithCost: number;
} {
  let costUsd = 0;
  let runsWithCost = 0;
  for (const row of rows) {
    if (row.costUsd === null) continue;
    const n = Number(row.costUsd);
    if (!Number.isFinite(n)) continue;
    costUsd += n;
    runsWithCost += 1;
  }
  return { costUsd, runCount: rows.length, runsWithCost };
}

/**
 * Runs queued on this stage since the card last entered it. No entry
 * timestamp means this visit has no history row (legacy data, tests),
 * so every run on the stage is counted.
 */
export function runsInVisit<T extends { queuedAt: Date }>(rows: T[], enteredAt: Date | null): T[] {
  if (!enteredAt) return rows;
  return rows.filter((row) => row.queuedAt >= enteredAt);
}

/**
 * Records what the visit cost now that the card has left the stage.
 * Awaited so the event is queued before the caller moves on, the same
 * reason `captureRunFinished` is awaited. Failures stay in a warning:
 * a PostHog outage must not fail an advance that already committed.
 */
export async function captureStageSpend(
  ctx: Pick<AppContext, "db" | "analytics">,
  args: {
    feature: { id: string; projectId: string; organizationId: string | null };
    stageId: string;
    trigger: StageSpendTrigger;
    actorUserId?: string | null;
    toStageId?: string | null;
  },
): Promise<void> {
  const analytics = ctx.analytics;
  if (!analytics) return;
  try {
    const runRows = await ctx.db
      .select({
        costUsd: agentRuns.costUsd,
        queuedAt: agentRuns.queuedAt,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.featureId, args.feature.id), eq(agentRuns.stageId, args.stageId)));

    const [stage] = await ctx.db
      .select({ name: stages.name, slug: stages.slug })
      .from(stages)
      .where(eq(stages.id, args.stageId))
      .limit(1);

    const [entered] = await ctx.db
      .select({ at: featureEvents.at })
      .from(featureEvents)
      .where(
        and(
          eq(featureEvents.featureId, args.feature.id),
          eq(featureEvents.kind, "stage_moved"),
          eq(featureEvents.toStageId, args.stageId),
        ),
      )
      .orderBy(desc(featureEvents.at))
      .limit(1);

    const visit = runsInVisit(runRows, entered?.at ?? null);
    const { costUsd, runCount, runsWithCost } = tallyStageSpend(visit);

    analytics.capture({
      event: AGENT_STAGE_SPEND_EVENT,
      userId: args.actorUserId ?? null,
      organizationId: args.feature.organizationId,
      properties: {
        cost_usd: costUsd,
        run_count: runCount,
        runs_with_cost: runsWithCost,
        feature_id: args.feature.id,
        stage_id: args.stageId,
        stage_name: stage?.name ?? null,
        stage_slug: stage?.slug ?? null,
        project_id: args.feature.projectId,
        trigger: args.trigger,
        to_stage_id: args.toStageId ?? null,
      },
    });
  } catch (err) {
    console.warn(`could not record stage spend for feature ${args.feature.id}:`, err);
    analytics.captureException(err, args.actorUserId ?? null, args.feature.organizationId, {
      feature_id: args.feature.id,
      source: "stage_spend",
    });
  }
}
