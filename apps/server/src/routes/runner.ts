import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { agentEvent, forgetsBetweenRuns } from "@bento/core";
import { agentProfiles, agentRuns, features, projects, repositories, runEvents, stages } from "@bento/db";
import { canAccessProject, visibleProjectFilter } from "../access.js";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { buildStagePrompt } from "../orchestrator/prompt.js";
import { compactedConversation } from "../orchestrator/conversation-history.js";
import { isUniqueViolation } from "../orchestrator/transcript.js";
import { captureRunFinished, deliverQueuedMessage, runnerReportedError } from "../orchestrator/run-executor.js";
import { runOutputPreview } from "../orchestrator/run-executor.js";
import { queueRunFinishedSlack } from "../orchestrator/slack-notify.js";
import { ACTIVE_RUN_STATUSES } from "../orchestrator/start-run.js";

const claimInput = z.object({
  /** Identifies the machine claiming work, for display and debugging. */
  runnerId: z.string().min(1).max(128),
});

const eventsInput = z.object({
  /** Must match the runner that claimed the run. */
  runnerId: z.string().min(1).max(128),
  events: z.array(agentEvent).max(500),
});

const completeInput = z.object({
  runnerId: z.string().min(1).max(128),
  ok: z.boolean(),
  sessionId: z.string().optional(),
  costUsd: z.number().optional(),
  numTurns: z.number().int().optional(),
  exitCode: z.number().int().optional(),
  error: z.string().optional(),
});

/**
 * Endpoints for a machine that executes agent runs locally while the
 * server holds the board.
 *
 * This is the middle option between a thin client and running everything
 * locally: your organization, projects, and history live on the server,
 * but agents run in containers on your own machine with your own
 * checkouts and credentials, which never reach the server.
 */
/**
 * Authorizes a report about a run.
 *
 * Reporting endpoints are as powerful as the orchestrator itself: they
 * write transcripts and decide whether a stage passed, which can advance
 * a card and start the next agent. So a caller must be able to see the
 * run's project, the run must be runner-executed, and it must be the
 * machine that claimed it. Anything else is refused as not found, which
 * avoids confirming that a run id exists.
 */
async function authorizeReport(
  ctx: AppContext,
  c: Context,
  runId: string,
  runnerId: string,
) {
  const [run] = await db(c, ctx).select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return { error: "not found" as const, status: 404 as const };

  const [feature] = await db(c, ctx).select().from(features).where(eq(features.id, run.featureId));
  if (!feature) return { error: "not found" as const, status: 404 as const };
  if (!(await canAccessProject(ctx, c, feature.projectId))) {
    return { error: "not found" as const, status: 404 as const };
  }
  if (run.executor !== "runner") {
    return { error: "this run is executed by the server" as const, status: 409 as const };
  }
  if (run.claimedBy !== runnerId) {
    return { error: "this run was claimed by a different machine" as const, status: 409 as const };
  }
  return { run, feature };
}

export function runnerRoutes(ctx: AppContext) {
  return new Hono()
    /**
     * Claims the oldest queued run the caller may see that is marked for
     * runner execution. Returns everything needed to execute it, so a
     * runner needs no other API calls to get started.
     */
    .post("/claim", zValidator("json", claimInput), async (c) => {
      const { runnerId } = c.req.valid("json");

      const visible = await db(c, ctx).select({ id: projects.id }).from(projects).where(await visibleProjectFilter(ctx, c));
      const projectIds = visible.map((p) => p.id);
      if (projectIds.length === 0) return c.json({ run: null });

      const candidates = await db(c, ctx)
        .select({ run: agentRuns, feature: features })
        .from(agentRuns)
        .innerJoin(features, eq(features.id, agentRuns.featureId))
        .where(
          and(
            eq(agentRuns.status, "queued"),
            eq(agentRuns.executor, "runner"),
            isNull(agentRuns.claimedBy),
            inArray(features.projectId, projectIds),
          ),
        )
        .orderBy(asc(agentRuns.queuedAt))
        .limit(1);

      const candidate = candidates[0];
      if (!candidate) return c.json({ run: null });

      // Conditional update is the lock: a second runner racing for the
      // same row updates zero rows and simply polls again.
      const claimed = await db(c, ctx)
        .update(agentRuns)
        .set({ status: "starting", claimedBy: runnerId, claimedAt: new Date(), startedAt: new Date() })
        .where(and(eq(agentRuns.id, candidate.run.id), isNull(agentRuns.claimedBy)))
        .returning();
      if (claimed.length === 0) return c.json({ run: null });

      const [profile] = await db(c, ctx)
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.id, candidate.run.agentProfileId));
      const [stage] = await db(c, ctx).select().from(stages).where(eq(stages.id, candidate.run.stageId));
      const allStages = await db(c, ctx)
        .select()
        .from(stages)
        .where(eq(stages.pipelineId, candidate.feature.pipelineId))
        .orderBy(asc(stages.position));
      const repoRows = await db(c, ctx)
        .select()
        .from(repositories)
        .where(eq(repositories.projectId, candidate.feature.projectId))
        .orderBy(asc(repositories.position));

      if (!profile || !stage) return c.json({ error: "run has dangling references" }, 500);

      ctx.bus.emitBoardEvent({
        type: "run_updated",
        projectId: candidate.feature.projectId,
        featureId: candidate.feature.id,
        runId: candidate.run.id,
        status: "starting",
      });

      const resume = Boolean(candidate.run.cliSessionId) && !forgetsBetweenRuns(profile.cli);
      // Same gate as the server executor: judge and rebase prompts are
      // complete on their own and never take a compacted history.
      const compacted =
        candidate.run.prompt && candidate.run.kind === "task" && !resume
          ? await compactedConversation(db(c, ctx), candidate.feature.id, candidate.run.id)
          : "";

      return c.json({
        run: {
          id: candidate.run.id,
          featureId: candidate.feature.id,
          stageId: stage.id,
          prompt: candidate.run.prompt,
          resumeSessionId: candidate.run.cliSessionId,
          kind: candidate.run.kind,
        },
        feature: { id: candidate.feature.id, title: candidate.feature.title, branchName: candidate.feature.branchName },
        agent: { cli: profile.cli, model: profile.model, extraArgs: profile.extraArgs },
        repositories: repoRows.map((r) => ({
          name: r.name,
          localPath: r.localPath,
          defaultBranch: r.defaultBranch,
        })),
        /** Used when the run carries no explicit prompt. */
        stagePrompt: buildStagePrompt(candidate.feature, stage, allStages, [], { name: profile.name, skill: profile.skill }),
        /**
         * Prior turns, compacted, for a follow-up that cannot resume a
         * CLI session. Empty when the run resumes or there is nothing
         * to carry.
         */
        compactedConversation: compacted,
      });
    })

    /** Appends transcript events produced by a runner. */
    .post("/runs/:id/events", zValidator("json", eventsInput), async (c) => {
      const runId = c.req.param("id");
      const authorized = await authorizeReport(ctx, c, runId, c.req.valid("json").runnerId);
      if ("error" in authorized) return c.json({ error: authorized.error }, authorized.status);
      const { run } = authorized;
      // Resolved once per report batch, for the board's output line.
      const [owner] = await db(c, ctx)
        .select({ featureId: features.id, projectId: features.projectId })
        .from(features)
        .where(eq(features.id, run.featureId));

      if (run.status === "starting") {
        await db(c, ctx).update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, runId));
      }

      /**
       * One transaction around the counter read and the inserts. Two
       * batches reporting concurrently both computed the same max(seq)
       * and collided on the (runId, seq) unique index halfway through,
       * leaving one batch partially written and the runner retrying
       * into duplicates.
       *
       * Retried as a whole on that collision: the transaction rolled
       * back cleanly, and the server also writes to this transcript
       * (the reaper's requeue note, a finish line), so a collision does
       * not need the runner to notice and resend the batch.
       */
      const events = c.req.valid("json").events;
      const writeBatch = () =>
        db(c, ctx).transaction(async (tx) => {
          // max() in SQL: loading every row grew with transcript length.
          const [highest] = await tx
            .select({ seq: max(runEvents.seq) })
            .from(runEvents)
            .where(eq(runEvents.runId, runId));
          let next = highest?.seq ?? 0;
          for (const event of events) {
            next += 1;
            await tx.insert(runEvents).values({ runId, seq: next, type: event.type, payload: event });
            /**
             * The session id reaches the run row the moment the CLI
             * announces it, same as server-executed runs: a runner whose
             * machine dies mid-run must not take the conversation's only
             * key with it.
             */
            const announced = (event as { type?: string; sessionId?: string }).sessionId;
            if (event.type === "init" && typeof announced === "string" && announced) {
              await tx.update(agentRuns).set({ cliSessionId: announced }).where(eq(agentRuns.id, runId));
            }
          }
          return next;
        });
      let seq: number;
      for (let attempt = 0; ; attempt++) {
        try {
          seq = await writeBatch();
          break;
        } catch (err) {
          if (!isUniqueViolation(err) || attempt >= 5) throw err;
        }
      }

      let emitted = seq - events.length;
      for (const event of events) {
        emitted += 1;
        ctx.bus.emitRunEvent({ runId, seq: emitted, event });
        // Runner-executed agents reach the board the same way.
        const spoken = runOutputPreview(event as { type: string; role?: string; text?: string });
        if (spoken && owner) {
          ctx.bus.emitBoardEvent({
            type: "run_output",
            projectId: owner.projectId,
            featureId: owner.featureId,
            runId,
            text: spoken,
          });
        }
      }
      return c.json({ ok: true, seq });
    })

    /** Reports a runner-executed run as finished, and re-checks the gate. */
    .post("/runs/:id/complete", zValidator("json", completeInput), async (c) => {
      const runId = c.req.param("id");
      const body = c.req.valid("json");
      const authorized = await authorizeReport(ctx, c, runId, body.runnerId);
      if ("error" in authorized) return c.json({ error: authorized.error }, authorized.status);
      const { feature, run } = authorized;
      const [profile] = await db(c, ctx)
        .select({ cli: agentProfiles.cli })
        .from(agentProfiles)
        .where(eq(agentProfiles.id, run.agentProfileId));

      /**
       * Compare-and-set, the same one every other terminal writer
       * uses. Without it, a report retried after a lost response, or
       * one landing after the user cancelled, overwrote the terminal
       * status (a cancelled run read as succeeded) and counted the
       * run's ending twice. The loser changes nothing and is told ok:
       * the run has ended, which is all the runner was reporting.
       */
      const [closed] = await db(c, ctx)
        .update(agentRuns)
        .set({
          status: body.ok ? "succeeded" : "failed",
          endedAt: new Date(),
          exitCode: body.exitCode ?? null,
          // Only when the runner actually said: a report without a
          // session id must not erase one already recorded, or the
          // conversation ends with the failure it should survive.
          ...(body.sessionId !== undefined ? { cliSessionId: body.sessionId } : {}),
          costUsd: body.costUsd !== undefined ? String(body.costUsd) : null,
          numTurns: body.numTurns ?? null,
          error: body.ok ? (body.error ?? null) : runnerReportedError(profile?.cli, body.error),
        })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .returning({ id: agentRuns.id });
      if (!closed) return c.json({ ok: true });
      await deliverQueuedMessage(ctx, runId);
      await queueRunFinishedSlack(ctx, runId);

      // Runner runs end here rather than in finishRun, so the same
      // event every other ending emits is emitted here, through the
      // same builder. Only the capture: entitlements' onRunFinished
      // meters the deployment's compute, and a runner run burned the
      // runner's own machine.
      await captureRunFinished(ctx, runId, body.ok ? "succeeded" : "failed");

      {
        ctx.bus.emitRunDone(runId, body.ok ? "succeeded" : "failed");
        ctx.bus.emitBoardEvent({
          type: "run_updated",
          projectId: feature.projectId,
          featureId: feature.id,
          runId,
          status: body.ok ? "succeeded" : "failed",
        });
        await ctx.boss.send("gate.evaluate", { featureId: feature.id });
      }
      return c.json({ ok: true });
    });
}
