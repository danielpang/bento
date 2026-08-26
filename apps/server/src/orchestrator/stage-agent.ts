import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentRuns, projects, stages, type Db } from "@bento/db";
import type { AppContext } from "../context.js";
import { ACTIVE_RUN_STATUSES, startRunIfIdle } from "./start-run.js";
import { requeueUndelivered } from "./messages.js";
import { followUpSource, type FollowUpWorkRun } from "./follow-up-source.js";

export { followUpSource, type FollowUpWorkRun };

/**
 * Loads the current stage's assigned agent and decides who a follow-up
 * continues. Callers already have the last work run; this is the stage
 * lookup they would otherwise copy.
 */
export async function resolveFollowUpRun(
  db: Db,
  feature: { currentStageId: string | null },
  lastWorkRun: FollowUpWorkRun,
): Promise<FollowUpWorkRun> {
  let assignedAgentProfileId: string | null = null;
  if (feature.currentStageId) {
    const [stage] = await db
      .select({ defaultAgentProfileId: stages.defaultAgentProfileId })
      .from(stages)
      .where(eq(stages.id, feature.currentStageId))
      .limit(1);
    assignedAgentProfileId = stage?.defaultAgentProfileId ?? null;
  }
  return followUpSource({
    currentStageId: feature.currentStageId,
    assignedAgentProfileId,
    lastWorkRun,
  });
}

/**
 * Starts the agent assigned to this stage, the same way arriving by
 * advance or by a forward drag does.
 *
 * No agent, or a stage already looping, starts nothing: the card still
 * moved, and a person can run an agent by hand. Busy is the working
 * run's problem; its finish queues the evaluation that will look here.
 */
export async function startAssignedStageAgent(
  ctx: AppContext,
  feature: { id: string; projectId: string },
  stage: { id: string; defaultAgentProfileId: string | null },
): Promise<void> {
  if (!stage.defaultAgentProfileId) return;
  if (await stageIsLooping(ctx, feature.id, stage.id)) return;

  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId));
  const executor = project?.executor ?? "server";
  const run = await startRunIfIdle(
    ctx.db,
    {
      featureId: feature.id,
      stageId: stage.id,
      agentProfileId: stage.defaultAgentProfileId,
      prompt: "",
      executor,
    },
    ctx.entitlements,
    ctx.analytics,
  );
  if (run !== "busy" && run !== "gone" && !("outOfCompute" in run) && executor === "server") {
    await ctx.boss.send("run.execute", { runId: run.id });
  }
}

/**
 * Stops agents still working a different stage of this card.
 *
 * Send-back has to actually switch: leaving the previous stage's agent
 * running keeps the card busy, so a follow-up still lands in the old
 * conversation and the person cannot start the destination one. Runs
 * already on the stage being entered are left alone. Keep-stage null
 * means the backlog, so every working run stops.
 *
 * Does not deliver parked messages as a resume of the stopped agent.
 * Those wait for the person to start the destination conversation,
 * which is how they say why the card came back.
 */
export async function stopRunsOutsideStage(
  ctx: AppContext,
  feature: { id: string; projectId: string },
  keepStageId: string | null,
): Promise<void> {
  const active = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, feature.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)));
  /**
   * Billing and analytics: the same announcement a person-stopped run
   * gets. Imported here so this file does not close a cycle with
   * run-executor, which already imports resolveFollowUpRun from here.
   */
  const { captureRunFinished } = active.length > 0 ? await import("./run-executor.js") : { captureRunFinished: null };
  for (const run of active) {
    if (keepStageId && run.stageId === keepStageId) continue;
    ctx.running.get(run.id)?.abort();
    const [closed] = await ctx.db
      .update(agentRuns)
      .set({ status: "cancelled", endedAt: new Date(), error: null })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
      .returning({ id: agentRuns.id });
    if (!closed) continue;
    const announce = ctx.entitlements?.onRunFinished;
    if (announce) {
      void announce(run.id).catch((err: unknown) => {
        console.warn(`could not record what run ${run.id} cost:`, err);
      });
    }
    if (captureRunFinished) await captureRunFinished(ctx, run.id, "cancelled");
    ctx.bus.emitRunDone(run.id, "cancelled");
    ctx.bus.emitBoardEvent({
      type: "run_updated",
      projectId: feature.projectId,
      featureId: feature.id,
      runId: run.id,
      status: "cancelled",
    });
    await requeueUndelivered(ctx.db, run.id);
  }
}

/**
 * True when automatic hand-off into this stage has already run enough
 * times recently that another start would be a loop.
 *
 * The specific runaway: a gate that never passes sends the card back,
 * the evaluator hands it to the same agent, the agent fails the same
 * way, and nobody is in the loop while the meter runs. A person
 * starting a run by hand is unaffected, which is the point: the guard
 * is on the automatic door, not on the card.
 *
 * Counted within the current period rather than for all time, so a
 * long lived card that legitimately revisits a stage over months is
 * not held against its own history.
 */
export async function stageIsLooping(ctx: AppContext, featureId: string, stageId: string): Promise<boolean> {
  const since = new Date(Date.now() - LOOP_WINDOW_MS);
  /**
   * Only the runs the evaluator itself started. The count used to take
   * every run on the stage, so three chat messages in an afternoon,
   * each of which resumes as its own run, silently disabled automatic
   * hand-off into that stage, the exact opposite of the promise below
   * that a person is unaffected. Evaluator starts carry no started_by,
   * and the judge, which also carries none, is excluded by its prompt
   * prefix: judging is the gate examining work, not the loop this
   * guard exists to catch.
   */
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.featureId, featureId),
        eq(agentRuns.stageId, stageId),
        gte(agentRuns.queuedAt, since),
        isNull(agentRuns.startedBy),
        ne(agentRuns.kind, "judge"),
      ),
    );
  const started = row?.count ?? 0;
  if (started < MAX_AUTO_STARTS_PER_STAGE) return false;
  console.warn(
    `feature ${featureId} has been handed to stage ${stageId} ${started} times in the last day; not starting it again automatically`,
  );
  return true;
}

/**
 * Three automatic starts on one stage. Enough for a stage that
 * legitimately retries, few enough that a loop is caught in hours
 * rather than in an invoice.
 */
const MAX_AUTO_STARTS_PER_STAGE = 3;
const LOOP_WINDOW_MS = 24 * 60 * 60 * 1000;
