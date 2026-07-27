import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { gateCriteria, type GateCriterion } from "@bento/core";
import { agentProfiles, agentRuns, featureEvents, featurePullRequests, features, gateChecks, projects, repositories, runEvents, sandboxes, stages } from "@bento/db";
import { evaluateGate, type GateContext, type GateResult } from "@bento/gates";
import { parseRepoUrl } from "@bento/github";
import type { AppContext } from "../context.js";
import { githubConnectionFor } from "../github.js";
import { ACTIVE_RUN_STATUSES, startRunIfIdle } from "./start-run.js";

type Feature = typeof features.$inferSelect;
type Stage = typeof stages.$inferSelect;

/**
 * Evaluates the current stage's gate for one feature and advances the
 * card when every criterion passes.
 *
 * Manual approval is recorded as a gate_check row rather than a separate
 * flag, so a stage can mix "a human approved" with automated criteria
 * such as "tests pass" and "no unresolved PR comments".
 */
export async function evaluateFeatureGate(ctx: AppContext, featureId: string): Promise<void> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  if (!feature?.currentStageId) return;
  if (feature.status === "done" || feature.status === "cancelled") return;

  const [stage] = await ctx.db.select().from(stages).where(eq(stages.id, feature.currentStageId));
  if (!stage) return;

  /**
   * A manual stage is a person's decision and nothing else, so there is
   * nothing here to evaluate: it moves when someone approves, and goes
   * back when someone rejects. A stage carrying the legacy `manual`
   * criterion is manual too, whatever its mode says, which is what
   * keeps pipelines built before the mode existed behaving as they did.
   */
  const declared = parseCriteria(stage.gateCriteria);
  if (stage.gateType === "manual" || declared.some((c) => c.type === "manual")) {
    await markWaitingForApproval(ctx, feature, stage);
    return;
  }

  /**
   * An automatic stage with nothing asked of it means "run the agent,
   * then move on". Spelled out rather than treated as an empty gate
   * that trivially passes: a card must not skip past a stage before its
   * agent has done the work.
   */
  const criteria: GateCriterion[] = declared.length > 0 ? declared : [{ type: "run_succeeded" }];

  const [lastRun] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, feature.id), eq(agentRuns.stageId, stage.id)))
    .orderBy(desc(agentRuns.queuedAt))
    .limit(1);

  // A stage whose agent has not finished successfully is not ready to be judged.
  if (lastRun && (lastRun.status === "queued" || lastRun.status === "starting" || lastRun.status === "running")) {
    return;
  }

  /**
   * Waiting on a run that no agent will ever start.
   *
   * Only when the gate actually depends on one: a stage asking for a
   * command to pass, or for checks to be green, needs no agent and is
   * perfectly able to answer. Nothing would ask again either, since
   * runs are what queue an evaluation and the sweep only revisits cards
   * already marked gated, so this says why instead of stalling silently.
   */
  const needsRun = criteria.some((criterion) => criterion.type === "run_succeeded");
  if (needsRun && !lastRun && !stage.defaultAgentProfileId) {
    await holdFeature(ctx, feature, stage.id, [
      {
        criterion: { type: "run_succeeded" },
        status: "failed",
        message: "No agent is assigned to this stage, so nothing can run",
      },
    ]);
    return;
  }

  /**
   * False, always: a stage that wants a person took the manual branch
   * above and never reaches here. The field stays on the context
   * because the criterion type still exists for stages built before
   * the mode did, and reading it as unapproved is the honest answer
   * for the automatic stages that do get this far.
   */
  const gateCtx: GateContext = { manuallyApproved: false };

  if (lastRun?.status === "succeeded" || lastRun?.status === "failed" || lastRun?.status === "cancelled") {
    gateCtx.lastRunStatus = lastRun.status;
  }

  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId));
  const github = await githubConnectionFor(ctx, project?.organizationId ?? null);
  if (github) {
    const linked = await ctx.db
      .select()
      .from(featurePullRequests)
      .where(eq(featurePullRequests.featureId, feature.id));

    // Rows come from publishing, one per repository the agent committed
    // in. The project's own repoUrl with the feature's mirrored number
    // is the fallback for a pull request someone linked by hand, from
    // before there were rows, or without a GitHub App to open one.
    const refs =
      linked.length > 0
        ? linked.flatMap((row) => {
            const parsed = parseRepoUrl(row.repoUrl);
            return parsed ? [{ owner: parsed.owner, repo: parsed.repo, prNumber: row.number }] : [];
          })
        : project?.repoUrl && feature.prNumber
          ? (() => {
              const parsed = parseRepoUrl(project.repoUrl);
              return parsed ? [{ owner: parsed.owner, repo: parsed.repo, prNumber: feature.prNumber }] : [];
            })()
          : [];

    if (refs.length > 0) {
      gateCtx.github = github;
      gateCtx.prs = refs;
    }
  }

  if (criteria.some((c) => c.type === "agent_judge")) {
    gateCtx.judge = (criterion) => judgeStageWork(ctx, feature, stage, criterion, project?.executor ?? "server");
  }

  if (criteria.some((c) => c.type === "command")) {
    const [sandbox] = await ctx.db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.featureId, feature.id))
      .orderBy(desc(sandboxes.createdAt))
      .limit(1);
    if (sandbox && sandbox.status !== "destroyed") {
      // Match the agent's working directory so "pnpm test" means the
      // same thing in a gate as it does in a run.
      const repoRows = await ctx.db.select().from(repositories).where(eq(repositories.projectId, feature.projectId));
      const workdir = repoRows.length === 1 ? `${sandbox.workdir}/${repoRows[0]!.name}` : sandbox.workdir;
      gateCtx.sandbox = {
        handle: {
          externalId: sandbox.externalId,
          provider: sandbox.provider === "sprite" ? "sprite" : ctx.driver.provider,
          workdir,
        },
        exec: (handle, argv, opts) => ctx.driver.exec(handle, argv, opts),
      };
    }
  }

  const outcome = await evaluateGate(criteria, gateCtx);

  await ctx.db.delete(gateChecks).where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, stage.id)));
  if (outcome.outcomes.length > 0) {
    await ctx.db.insert(gateChecks).values(
      outcome.outcomes.map((o) => ({
        featureId: feature.id,
        stageId: stage.id,
        criterion: o.criterion as unknown as Record<string, unknown>,
        status: o.result.status,
        detail: { message: o.result.detail, ...(o.result.data ?? {}) },
        lastEvaluatedAt: new Date(),
      })),
    );
  }

  if (!outcome.passed) {
    if (feature.status !== "gated") {
      await ctx.db.update(features).set({ status: "gated", updatedAt: new Date() }).where(eq(features.id, feature.id));
      await recordFeatureEvent(ctx, {
        featureId: feature.id,
        kind: "status_changed",
        fromStatus: feature.status,
        toStatus: "gated",
        trigger: "gate_auto",
        ...(lastRun ? { runId: lastRun.id } : {}),
        detail: {
          failedCriteria: outcome.outcomes.filter((o) => o.result.status !== "passed").map((o) => o.criterion.type),
        },
      });
      ctx.bus.emitBoardEvent({
        type: "feature_updated",
        projectId: feature.projectId,
        featureId: feature.id,
        status: "gated",
        currentStageId: stage.id,
      });
    }
    return;
  }

  // Pass the stage this decision was made about: concurrent evaluations
  // (two runs finishing together) must not each advance the card.
  await advanceFeature(ctx, feature.id, "gate_auto", undefined, stage.id);
}

/**
 * Appends to a feature's history. Stage moves and status changes share
 * the log so "what happened to this card" is one ordered query.
 */
export async function recordFeatureEvent(
  ctx: AppContext,
  event: {
    featureId: string;
    kind: "stage_moved" | "status_changed";
    fromStageId?: string | null;
    toStageId?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    trigger: "manual" | "manual_back" | "gate_auto" | "gate_auto_back" | "agent_run" | "system";
    actorUserId?: string | null;
    runId?: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await ctx.db.insert(featureEvents).values({
    featureId: event.featureId,
    kind: event.kind,
    fromStageId: event.fromStageId ?? null,
    toStageId: event.toStageId ?? null,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    trigger: event.trigger,
    actorUserId: event.actorUserId ?? null,
    runId: event.runId ?? null,
    detail: event.detail ?? null,
  });
}

/**
 * Moves a feature to the next stage (or done) and, when the next stage
 * has a default agent profile, queues that stage's run automatically.
 * Shared by the manual approve route and automatic gate advancement.
 */
export async function advanceFeature(
  ctx: AppContext,
  featureId: string,
  trigger: "manual" | "gate_auto",
  actorUserId?: string,
  /**
   * The stage the caller believes the card is on: a stage id, or null
   * for "still in the backlog". When given, the move only happens if
   * that is still true, so concurrent advances (two gate evaluations,
   * or a double-clicked button) cannot move the card twice.
   */
  expectedStageId?: string | null,
): Promise<{ status: string; currentStageId: string | null } | null> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  if (!feature) return null;
  if (expectedStageId !== undefined && feature.currentStageId !== expectedStageId) return null;

  const stageRows = await ctx.db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, feature.pipelineId))
    .orderBy(asc(stages.position));
  if (stageRows.length === 0) return null;

  const currentIndex = feature.currentStageId ? stageRows.findIndex((s) => s.id === feature.currentStageId) : -1;
  const nextStage = stageRows[currentIndex + 1];
  const branchName = feature.branchName ?? `feature/${slugify(feature.title)}-${feature.id.slice(0, 8)}`;

  // The stage guard is part of the update, so the check and the move are
  // one atomic step rather than two.
  const guard =
    expectedStageId === undefined
      ? eq(features.id, feature.id)
      : expectedStageId === null
        ? and(eq(features.id, feature.id), isNull(features.currentStageId))
        : and(eq(features.id, feature.id), eq(features.currentStageId, expectedStageId));

  const [updated] = await ctx.db
    .update(features)
    .set(
      nextStage
        ? { status: "active", currentStageId: nextStage.id, branchName, updatedAt: new Date() }
        : { status: "done", updatedAt: new Date() },
    )
    .where(guard)
    .returning();
  // Another evaluation moved the card first; leave it alone.
  if (!updated) return null;

  await recordFeatureEvent(ctx, {
    featureId: feature.id,
    kind: "stage_moved",
    fromStageId: feature.currentStageId,
    // Null when the card just left the last stage: there is nowhere further.
    toStageId: nextStage ? nextStage.id : null,
    trigger,
    actorUserId: actorUserId ?? null,
  });
  if (!nextStage) {
    await recordFeatureEvent(ctx, {
      featureId: feature.id,
      kind: "status_changed",
      fromStatus: feature.status,
      toStatus: "done",
      trigger,
      actorUserId: actorUserId ?? null,
    });
  }

  ctx.bus.emitBoardEvent({
    type: "feature_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    ...(updated?.status ? { status: updated.status } : {}),
    currentStageId: updated?.currentStageId ?? null,
  });

  /**
   * A stage with no agent still has to be judged, or the card stops
   * dead: runs are what queue an evaluation, so a stage that starts no
   * run would never be looked at again, and the sweep only revisits
   * cards already marked gated. Asking here lets the stage advance on
   * criteria that need no agent, and otherwise say why it cannot.
   */
  if (nextStage && !nextStage.defaultAgentProfileId) {
    await ctx.boss.send("gate.evaluate", { featureId: feature.id });
  }

  // Hand off to the next stage's agent when one is configured. If a run
  // is somehow still working this card, nothing new starts: that run's
  // finish queues an evaluation, which is what will look at this stage.
  if (nextStage?.defaultAgentProfileId) {
    const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId));
    const executor = project?.executor ?? "server";
    const run = await startRunIfIdle(ctx.db, {
      featureId: feature.id,
      stageId: nextStage.id,
      agentProfileId: nextStage.defaultAgentProfileId,
      prompt: "",
      executor,
    });
    // Runner-executed runs wait to be claimed by a machine.
    if (run !== "busy" && executor === "server") await ctx.boss.send("run.execute", { runId: run.id });
  }

  return { status: updated?.status ?? "unknown", currentStageId: updated?.currentStageId ?? null };
}

/**
 * Sends a card to the previous stage, or back to the backlog from the
 * first one.
 *
 * Gate checks for the stage being left are discarded: an approval given
 * for work that is now being redone would otherwise let the card walk
 * straight forward again. The same stage guard the forward path uses
 * keeps a double click from skipping two stages back.
 */
/**
 * Puts a card in any stage of its pipeline, or back in the backlog.
 *
 * This is the primitive behind dragging a card between lanes, so it
 * keeps the meaning the two single-step moves already have rather than
 * inventing a third:
 *
 * - Forward is what advance means: the card is ready for that stage,
 *   so the stage's agent starts (or, agentless, its gate is asked).
 *   Dropping a card in a lane and watching nothing happen would be the
 *   silent failure this board keeps fighting.
 * - Backward is what send-back means: the work is being redone, so the
 *   checks of the stage being left are discarded and nothing starts on
 *   its own. A drag is not an approval either way, so no approval is
 *   recorded.
 *
 * Returns null when the card moved under the caller, or the target is
 * not a stage of this card's pipeline.
 */
export async function moveFeatureTo(
  ctx: AppContext,
  featureId: string,
  targetStageId: string | null,
  actorUserId?: string,
): Promise<{ status: string; currentStageId: string | null } | null> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  if (!feature) return null;
  if (feature.currentStageId === targetStageId) {
    return { status: feature.status, currentStageId: feature.currentStageId };
  }

  const stageRows = await ctx.db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, feature.pipelineId))
    .orderBy(asc(stages.position));
  const target = targetStageId ? stageRows.find((s) => s.id === targetStageId) : null;
  if (targetStageId && !target) return null;

  const fromIndex = feature.currentStageId ? stageRows.findIndex((s) => s.id === feature.currentStageId) : -1;
  const toIndex = target ? stageRows.findIndex((s) => s.id === target.id) : -1;
  const forward = toIndex > fromIndex;
  const branchName = feature.branchName ?? `feature/${slugify(feature.title)}-${feature.id.slice(0, 8)}`;

  const guard = feature.currentStageId
    ? and(eq(features.id, feature.id), eq(features.currentStageId, feature.currentStageId))
    : and(eq(features.id, feature.id), isNull(features.currentStageId));
  const [updated] = await ctx.db
    .update(features)
    .set({ status: "active", currentStageId: targetStageId, branchName, updatedAt: new Date() })
    .where(guard)
    .returning();
  if (!updated) return null;

  // The stage being left keeps no verdicts: an approval or a green
  // check given for work that is now moving would let the card walk
  // straight past the next evaluation.
  if (feature.currentStageId) {
    await ctx.db
      .delete(gateChecks)
      .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, feature.currentStageId)));
  }

  await recordFeatureEvent(ctx, {
    featureId: feature.id,
    kind: "stage_moved",
    fromStageId: feature.currentStageId,
    toStageId: targetStageId,
    trigger: forward ? "manual" : "manual_back",
    actorUserId: actorUserId ?? null,
  });

  ctx.bus.emitBoardEvent({
    type: "feature_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    status: "active",
    currentStageId: targetStageId,
  });

  if (forward && target) {
    if (!target.defaultAgentProfileId) {
      await ctx.boss.send("gate.evaluate", { featureId: feature.id });
    } else {
      const [project] = await ctx.db.select().from(projects).where(eq(projects.id, feature.projectId));
      const executor = project?.executor ?? "server";
      // A drag during a run starts nothing extra: the working run's
      // finish queues the evaluation that will look at this stage.
      const run = await startRunIfIdle(ctx.db, {
        featureId: feature.id,
        stageId: target.id,
        agentProfileId: target.defaultAgentProfileId,
        prompt: "",
        executor,
      });
      if (run !== "busy" && executor === "server") await ctx.boss.send("run.execute", { runId: run.id });
    }
  }

  return { status: "active", currentStageId: targetStageId };
}

/**
 * Brings a finished card back onto the board, into the stage it
 * finished in.
 *
 * Deliberately quiet afterwards: no agent starts and no gate evaluates.
 * Someone reopening a card is about to change something, and an
 * automatic stage re-evaluated on the spot would read the old
 * successful run and walk the card straight back to done.
 *
 * The stage's old check rows are discarded like any backward move's:
 * an approval given before the reopen would say the redone work was
 * already judged.
 */
export async function reopenFeature(
  ctx: AppContext,
  featureId: string,
  actorUserId?: string,
): Promise<{ status: string; currentStageId: string | null } | null> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  // Done cards keep the stage they finished in, which is what makes
  // reopening into it possible at all.
  if (!feature || feature.status !== "done" || !feature.currentStageId) return null;

  const [updated] = await ctx.db
    .update(features)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(features.id, feature.id), eq(features.status, "done")))
    .returning();
  if (!updated) return null;

  await ctx.db
    .delete(gateChecks)
    .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, feature.currentStageId)));

  await recordFeatureEvent(ctx, {
    featureId: feature.id,
    kind: "status_changed",
    fromStatus: "done",
    toStatus: "active",
    trigger: "manual_back",
    actorUserId: actorUserId ?? null,
  });

  ctx.bus.emitBoardEvent({
    type: "feature_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    status: "active",
    currentStageId: feature.currentStageId,
  });

  return { status: "active", currentStageId: feature.currentStageId };
}

export async function moveFeatureBack(
  ctx: AppContext,
  featureId: string,
  trigger: "manual" | "gate_auto",
  actorUserId?: string,
): Promise<{ status: string; currentStageId: string | null } | null> {
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
  if (!feature?.currentStageId) return null;

  const stageRows = await ctx.db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, feature.pipelineId))
    .orderBy(asc(stages.position));
  const currentIndex = stageRows.findIndex((s) => s.id === feature.currentStageId);
  if (currentIndex < 0) return null;
  const previousStage = currentIndex > 0 ? stageRows[currentIndex - 1] : null;

  const [updated] = await ctx.db
    .update(features)
    .set({
      status: "active",
      currentStageId: previousStage ? previousStage.id : null,
      updatedAt: new Date(),
    })
    .where(and(eq(features.id, feature.id), eq(features.currentStageId, feature.currentStageId)))
    .returning();
  if (!updated) return null;

  await ctx.db
    .delete(gateChecks)
    .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, feature.currentStageId)));

  await recordFeatureEvent(ctx, {
    featureId: feature.id,
    kind: "stage_moved",
    fromStageId: feature.currentStageId,
    // Null means it went back to the backlog.
    toStageId: previousStage ? previousStage.id : null,
    trigger: trigger === "manual" ? "manual_back" : "gate_auto_back",
    actorUserId: actorUserId ?? null,
  });

  ctx.bus.emitBoardEvent({
    type: "feature_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    status: updated.status,
    currentStageId: updated.currentStageId,
  });

  return { status: updated.status, currentStageId: updated.currentStageId };
}

/** Records a human approval for the feature's current stage. */
export async function recordManualApproval(ctx: AppContext, featureId: string, stageId: string): Promise<void> {
  await ctx.db.insert(gateChecks).values({
    featureId,
    stageId,
    criterion: { type: "manual" },
    status: "passed",
    detail: { message: "Approved" },
    lastEvaluatedAt: new Date(),
  });
}

/**
 * Records that a person rejected the card here, before it is sent back.
 * Written as a failed check so the reason travels the same route to the
 * clients that every other gate outcome does.
 */
export async function recordRejection(
  ctx: AppContext,
  featureId: string,
  stageId: string,
  reason?: string,
): Promise<void> {
  await ctx.db.delete(gateChecks).where(and(eq(gateChecks.featureId, featureId), eq(gateChecks.stageId, stageId)));
  await ctx.db.insert(gateChecks).values({
    featureId,
    stageId,
    criterion: { type: "manual" },
    status: "failed",
    detail: { message: reason && reason.length > 0 ? `Rejected: ${reason}` : "Rejected" },
    lastEvaluatedAt: new Date(),
  });
}


/**
 * Marks a manual stage's card as waiting for a person.
 *
 * The decision is the only thing left, but the board reads status to
 * decide what needs attention: left active, a card whose agent has
 * finished shows its run as succeeded and reads as done rather than as
 * waiting for you. Only once nothing is still running, so a card with
 * an agent mid-flight stays honestly active.
 */
async function markWaitingForApproval(ctx: AppContext, feature: Feature, stage: Stage): Promise<void> {
  const [lastRun] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, feature.id), eq(agentRuns.stageId, stage.id)))
    .orderBy(desc(agentRuns.queuedAt))
    .limit(1);

  const running = lastRun && (lastRun.status === "queued" || lastRun.status === "starting" || lastRun.status === "running");
  if (running) return;
  // Nothing has happened here yet and an agent is coming: let it run
  // before asking anyone to judge the result.
  if (!lastRun && stage.defaultAgentProfileId) return;

  /**
   * Two separate facts, said separately: the agent's work is finished,
   * and a person has not decided yet. One row saying "run_succeeded,
   * pending" claimed the opposite of the first, which is the reading
   * someone would take off the card.
   */
  const rows: HoldRow[] = [];
  if (lastRun) {
    rows.push({
      criterion: { type: "run_succeeded" },
      status: lastRun.status === "succeeded" ? "passed" : "failed",
      // The gate panel is where people look first, so the failure
      // reason rides along instead of hiding a click away in the run.
      message:
        lastRun.status === "succeeded"
          ? "The agent completed"
          : lastRun.status === "cancelled"
            ? "The agent was stopped"
            : lastRun.error
              ? `The agent failed: ${lastRun.error.slice(0, 160)}`
              : "The agent failed",
    });
  }
  rows.push({ criterion: { type: "manual" }, status: "pending", message: "Waiting for your approval" });

  await holdFeature(ctx, feature, stage.id, rows);
}

/**
 * Stops a card where someone can see why.
 *
 * Marks it gated and records the reason as a check row, so the reason
 * reaches every client through the gate endpoints they already read
 * rather than needing a new channel. Idempotent: a card already held
 * for this reason is left alone, so the five minute sweep does not
 * write an event every five minutes.
 */
interface HoldRow {
  criterion: { type: string };
  status: "pending" | "passed" | "failed";
  message: string;
}

async function holdFeature(ctx: AppContext, feature: Feature, stageId: string, rows: HoldRow[]): Promise<void> {
  const existing = await ctx.db
    .select()
    .from(gateChecks)
    .where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, stageId)));
  const describe = (list: { status: string; message: string }[]) =>
    list.map((r) => `${r.status}:${r.message}`).join("|");
  const already =
    feature.status === "gated" &&
    describe(
      existing.map((r) => ({ status: r.status, message: (r.detail as { message?: string } | null)?.message ?? "" })),
    ) === describe(rows);
  if (already) return;

  await ctx.db.delete(gateChecks).where(and(eq(gateChecks.featureId, feature.id), eq(gateChecks.stageId, stageId)));
  await ctx.db.insert(gateChecks).values(
    rows.map((row) => ({
      featureId: feature.id,
      stageId,
      criterion: row.criterion as unknown as Record<string, unknown>,
      status: row.status,
      detail: { message: row.message },
      lastEvaluatedAt: new Date(),
    })),
  );

  if (feature.status !== "gated") {
    await ctx.db.update(features).set({ status: "gated", updatedAt: new Date() }).where(eq(features.id, feature.id));
    await recordFeatureEvent(ctx, {
      featureId: feature.id,
      kind: "status_changed",
      fromStatus: feature.status,
      toStatus: "gated",
      trigger: "gate_auto",
      detail: { message: rows[rows.length - 1]?.message ?? "" },
    });
  }
  ctx.bus.emitBoardEvent({
    type: "feature_updated",
    projectId: feature.projectId,
    featureId: feature.id,
    status: "gated",
    currentStageId: stageId,
  });
}

/**
 * Every judge prompt begins with this, and it is also how judge runs
 * are told apart from the stage's own work runs: the same profile can
 * be (unwisely) both worker and judge, so the run's role has to be
 * readable off the run itself.
 */
const JUDGE_PROMPT_PREFIX = "You are the completion judge";

function buildJudgePrompt(
  stage: Stage,
  profile: { name: string; skill: string | null },
): string {
  const parts = [
    `${JUDGE_PROMPT_PREFIX} for the stage "${stage.name}". Another agent has done the work; your job is to decide whether it is complete, not to finish it.`,
    stage.description ? `What this stage is for: ${stage.description}` : "",
    "Inspect the repository and judge the work against the stage's purpose. Do not change files, do not commit, do not push.",
    profile.skill ? `Your operating instructions:\n${profile.skill}` : "",
    "End your reply with a line reading exactly VERDICT: COMPLETE or VERDICT: INCOMPLETE, followed by one short sentence saying why.",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Reads the judge's ruling out of its finished run's transcript. */
async function readVerdict(
  ctx: AppContext,
  runId: string,
): Promise<{ verdict: "complete" | "incomplete"; reason: string } | null> {
  const rows = await ctx.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq));
  let found: { verdict: "complete" | "incomplete"; reason: string } | null = null;
  for (const row of rows) {
    const payload = row.payload as { type?: string; role?: string; text?: string } | null;
    if (payload?.type !== "message" || payload.role !== "assistant" || !payload.text) continue;
    const match = payload.text.match(/VERDICT:\s*(COMPLETE|INCOMPLETE)\b[.,:]?\s*([^\n]*)/i);
    if (match) {
      found = {
        verdict: match[1]!.toLowerCase() as "complete" | "incomplete",
        reason: (match[2] ?? "").trim(),
      };
    }
  }
  return found;
}

/**
 * The agent_judge criterion: a second agent rules on the work.
 *
 * The judge is a normal run on the same stage, so its reasoning is
 * readable in the card's transcript and its cost is counted, and
 * startRunIfIdle keeps it off the branch while anything else works.
 * The verdict is judged fresh: a judge run older than the newest work
 * run is about work that has since changed, so a new one starts.
 *
 * A judge run that errored is reported as a failed criterion and not
 * retried on its own: the sweep re-evaluates gated cards every five
 * minutes, and an agent that respawned on each pass would spend money
 * in a loop. Running the stage again gets a fresh judgment.
 */
async function judgeStageWork(
  ctx: AppContext,
  feature: Feature,
  stage: Stage,
  criterion: Extract<GateCriterion, { type: "agent_judge" }>,
  executor: string,
): Promise<GateResult> {
  const runs = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.featureId, feature.id), eq(agentRuns.stageId, stage.id)))
    .orderBy(desc(agentRuns.queuedAt));
  const isJudgeRun = (run: (typeof runs)[number]) =>
    run.agentProfileId === criterion.agentProfileId && (run.prompt ?? "").startsWith(JUDGE_PROMPT_PREFIX);
  const latestJudge = runs.find(isJudgeRun);
  const latestWork = runs.find((run) => !isJudgeRun(run));

  // The stage's own agent has not run yet and is coming: let the work
  // happen before anyone judges it.
  if (!latestWork && stage.defaultAgentProfileId) {
    return { status: "pending", detail: "Waiting for the agent to run before judging" };
  }

  const fresh = latestJudge && (!latestWork || latestJudge.queuedAt > latestWork.queuedAt);
  if (fresh) {
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(latestJudge.status)) {
      return { status: "pending", detail: "The judge agent is reviewing the work" };
    }
    if (latestJudge.status !== "succeeded") {
      return {
        status: "failed",
        detail:
          latestJudge.status === "cancelled"
            ? "The judge run was stopped. Run the stage's agent again for a fresh judgment."
            : "The judge run failed. Fix its error in the run log, then run the stage's agent again.",
      };
    }
    const ruling = await readVerdict(ctx, latestJudge.id);
    if (!ruling) {
      return {
        status: "failed",
        detail: "The judge finished without a verdict. Its reply must end with VERDICT: COMPLETE or VERDICT: INCOMPLETE.",
      };
    }
    if (ruling.verdict === "complete") {
      return {
        status: "passed",
        detail: ruling.reason ? `The judge ruled the work complete: ${ruling.reason}` : "The judge ruled the work complete",
      };
    }
    return {
      status: "failed",
      detail: ruling.reason ? `The judge ruled the work incomplete: ${ruling.reason}` : "The judge ruled the work incomplete",
    };
  }

  const [judgeProfile] = await ctx.db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.id, criterion.agentProfileId));
  if (!judgeProfile || judgeProfile.organizationId !== feature.organizationId) {
    return { status: "failed", detail: "The judge agent no longer exists. Pick another in the stage settings." };
  }

  const run = await startRunIfIdle(ctx.db, {
    featureId: feature.id,
    stageId: stage.id,
    agentProfileId: judgeProfile.id,
    prompt: buildJudgePrompt(stage, judgeProfile),
    executor: executor === "runner" ? "runner" : "server",
  });
  if (run === "busy") {
    return { status: "pending", detail: "Waiting for the current run to finish before judging" };
  }
  if (executor !== "runner") await ctx.boss.send("run.execute", { runId: run.id });
  return { status: "pending", detail: `${judgeProfile.name} is reviewing the work` };
}

function parseCriteria(raw: unknown): GateCriterion[] {
  const parsed = gateCriteria.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "feature"
  );
}
