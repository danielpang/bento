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

const PRODUCTION_ENVIRONMENT_FILTER = {
  type: "AND" as const,
  values: [
    {
      type: "AND" as const,
      values: [
        {
          key: "environment",
          value: ["production"],
          operator: "exact" as const,
          type: "event" as const,
        },
      ],
    },
  ],
};

function spendSeries() {
  return {
    kind: "EventsNode" as const,
    event: AGENT_STAGE_SPEND_EVENT,
    custom_name: "Spend (USD)",
    math: "sum" as const,
    math_property: "cost_usd",
  };
}

function trendsQuery(display: "BoldNumber" | "ActionsLineGraph" | "ActionsBarValue", breakdown?: string) {
  return {
    kind: "InsightVizNode" as const,
    source: {
      kind: "TrendsQuery" as const,
      dateRange: { date_from: "-30d" },
      interval: "day" as const,
      series: [spendSeries()],
      properties: PRODUCTION_ENVIRONMENT_FILTER,
      ...(breakdown
        ? { breakdownFilter: { breakdown, breakdown_type: "event" as const } }
        : {}),
      trendsFilter: {
        display,
        aggregationAxisPrefix: "$",
        decimalPlaces: 2,
      },
    },
  };
}

/**
 * The PostHog dashboard that tracks agent spend. Every insight sums
 * `cost_usd`; none of them count events. Applied by
 * `scripts/upsert-posthog-agent-spend-dashboard.mjs`.
 */
export const AGENT_STAGE_SPEND_DASHBOARD = {
  name: "Agent spend",
  description:
    "Reported agent cost after each stage completion, summed. A floor: some tools report no cost, and a run that fails before finishing reports none either.",
  filters: {
    date_from: "-30d",
    properties: [
      {
        key: "environment",
        value: ["production"],
        operator: "exact",
        type: "event",
      },
    ],
  },
  insights: [
    {
      name: "Total agent spend",
      description: "Sum of cost_usd on agent stage spend events over the last 30 days.",
      query: trendsQuery("BoldNumber"),
    },
    {
      name: "Agent spend over time",
      description: "Daily sum of cost_usd on agent stage spend events.",
      query: trendsQuery("ActionsLineGraph"),
    },
    {
      name: "Agent spend by stage",
      description: "Sum of cost_usd broken down by the stage that just completed.",
      query: trendsQuery("ActionsBarValue", "stage_name"),
    },
  ],
};

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
  }
}
