import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AgentCli, AgentDelta, TurnState } from "@bento/core";
import { agentProfiles, agentRuns, features, projects, runEvents, runQuestions, sandboxes, stages } from "@bento/db";
import type { AppContext } from "../context.js";
import { recordedRunEvent } from "../events.js";
import { deferAfterCommit, tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";
import { markCancelled } from "../orchestrator/run-executor.js";
import { nudgeRun, requestRunAbort, requestRunInterrupt } from "../orchestrator/run-ownership.js";
import { answersFor, openQuestions, storeAnswer } from "../orchestrator/questions.js";
import { getAdapter } from "@bento/agents";
import { modalNetworkForProject } from "../orchestrator/sandbox-network.js";
import { markSandboxAwake } from "../orchestrator/hibernate-sandbox.js";
import { CARD_BUSY, NO_REPOSITORIES, projectHasRepositories, startRunIfIdle } from "../orchestrator/start-run.js";
import { enqueueRun } from "../orchestrator/queue.js";
import type { SandboxDriver } from "@bento/sandbox";
import { driverForSandbox, SandboxDriverUnavailable } from "../orchestrator/sandbox-driver.js";
import { canAccessProject, getAccessibleFeature, getAccessibleRun, getAccessibleRunOutput } from "../access.js";
import { requireSwarms } from "../orchestrator/swarm/gate.js";
import { runsForCaller } from "../feature-flags.js";

const createRun = z.object({
  featureId: z.string().uuid(),
  agentProfileId: z.string().uuid(),
  /** Defaults to the feature's current stage. */
  stageId: z.string().uuid().optional(),
  /** Overrides the generated stage prompt when set. */
  prompt: z.string().optional(),
  /** Resume a previous CLI session. */
  resumeSessionId: z.string().optional(),
});

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function runRoutes(ctx: AppContext) {
  return new Hono()
    .post("/", zValidator("json", createRun), async (c) => {
      const body = c.req.valid("json");
      const feature = await getAccessibleFeature(ctx, c, body.featureId);
      if (!feature) return c.json({ error: "feature not found" }, 404);
      const stageId = body.stageId ?? feature.currentStageId;
      if (!stageId) return c.json({ error: "feature has no current stage; advance it first" }, 400);
      // A done card keeps the stage it finished in, so the stage check
      // alone would let an agent run on a card nobody is watching.
      if (feature.status === "done" || feature.status === "cancelled") {
        return c.json({ error: `feature is ${feature.status}; reopen it first` }, 409);
      }
      if (!(await projectHasRepositories(db(c, ctx), feature.projectId))) {
        return c.json({ error: NO_REPOSITORIES }, 409);
      }
      const [[stage], [profile]] = await Promise.all([
        db(c, ctx).select().from(stages).where(eq(stages.id, stageId)).limit(1),
        db(c, ctx).select().from(agentProfiles).where(eq(agentProfiles.id, body.agentProfileId)).limit(1),
      ]);
      if (!stage || stage.pipelineId !== feature.pipelineId) return c.json({ error: "stage not found" }, 404);
      if (!profile) return c.json({ error: "agent profile not found" }, 404);

      const [project] = await db(c, ctx).select().from(projects).where(eq(projects.id, feature.projectId));
      const executor = project?.executor ?? "server";

      const run = await startRunIfIdle(db(c, ctx), {
        type: "pipeline" as const,
        featureId: feature.id,
        stageId,
        agentProfileId: body.agentProfileId,
        prompt: body.prompt ?? "",
        cliSessionId: body.resumeSessionId ?? null,
        executor,
        startedBy: actor(c),
      }, ctx.entitlements, ctx.analytics, (task) => deferAfterCommit(c, async () => task()), ctx.env.BENTO_MODE);
      if (run === "busy") return c.json({ error: CARD_BUSY }, 409);
      // The card was deleted while this request was in flight.
      if (run === "gone") return c.json({ error: "feature not found" }, 404);
      if ("outOfCompute" in run) return c.json({ error: run.outOfCompute, code: "PLAN_LIMIT" }, 402);

      // Runner-executed runs stay queued until a machine claims them.
      if (executor === "server") await enqueueRun(ctx, run.id);
      return c.json(run, 201);
    })
    .get("/:id", async (c) => {
      const found = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      const [run] = await runsForCaller(ctx, c, [found.run]);
      return c.json(run);
    })
    /**
     * Continues a finished run in the same CLI session, so the agent
     * keeps its context ("also handle the empty case"). Requires the
     * original run to have captured a session id.
     */
    .post("/:id/resume", zValidator("json", z.object({ prompt: z.string().min(1) })), async (c) => {
      const accessible = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!accessible) return c.json({ error: "not found" }, 404);
      const previous = accessible.run;
      if (!previous.cliSessionId) return c.json({ error: "this run did not record a session, so it cannot be continued; start a new run instead" }, 400);
      if (!TERMINAL.has(previous.status)) return c.json({ error: "run is still active" }, 409);
      // Continuing a session is still starting a run, so the same rule
      // as starting one: not on a card that has already finished.
      const [owner] = await db(c, ctx).select().from(features).where(eq(features.id, previous.featureId));
      if (owner && (owner.status === "done" || owner.status === "cancelled")) {
        return c.json({ error: `feature is ${owner.status}; reopen it first` }, 409);
      }
      if (owner && !(await projectHasRepositories(db(c, ctx), owner.projectId))) {
        return c.json({ error: NO_REPOSITORIES }, 409);
      }

      const run = await startRunIfIdle(db(c, ctx), {
        type: "pipeline" as const,
        featureId: previous.featureId,
        stageId: previous.stageId,
        agentProfileId: previous.agentProfileId,
        prompt: c.req.valid("json").prompt,
        cliSessionId: previous.cliSessionId,
        executor: previous.executor,
        // The person resuming owns the hours, not whoever started the
        // run being resumed.
        startedBy: actor(c),
      }, ctx.entitlements, ctx.analytics, (task) => deferAfterCommit(c, async () => task()), ctx.env.BENTO_MODE);
      if (run === "busy") return c.json({ error: CARD_BUSY }, 409);
      if (run === "gone") return c.json({ error: "not found" }, 404);
      if ("outOfCompute" in run) return c.json({ error: run.outOfCompute, code: "PLAN_LIMIT" }, 402);
      if (previous.executor === "server") await enqueueRun(ctx, run.id);
      return c.json(run, 201);
    })
    /**
     * Stops a running agent. The user is taking over, so this is a
     * terminal state but not a failure, and it does not trip the gate.
     *
     * Server-executed runs are interrupted in place. A runner-executed
     * run is marked here and the machine notices when it next reports,
     * because the server cannot reach into someone else's process.
     */
    .post("/:id/cancel", async (c) => {
      const found = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      const run = found.run;
      if (TERMINAL.has(run.status)) return c.json({ error: `run already ${run.status}` }, 409);

      requestRunAbort(ctx, run.id);
      await markCancelled(ctx, run.id);
      ctx.bus.emitBoardEvent({
        type: "run_updated",
        projectId: found.feature.projectId,
        featureId: found.feature.id,
        runId: run.id,
        status: "cancelled",
      });
      const updated = await db(c, ctx).select().from(agentRuns).where(eq(agentRuns.id, run.id));
      const [visible] = await runsForCaller(ctx, c, updated);
      return c.json(visible);
    })
    /**
     * Stops the turn the agent is working on, without ending the run: the
     * session stays open for the person's next message, which is what
     * they stopped it to send. Only where the run went live on a tool
     * that can (Claude Code, Codex, opencode); anything else answers 409
     * and Stop remains.
     */
    .post("/:id/interrupt", async (c) => {
      const found = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      const run = found.run;
      if (run.status !== "running" || run.liveSession !== true) {
        return c.json({ error: "Only a running live session can be interrupted." }, 409);
      }
      // A stage's agent waits for the person after an interrupt. A judge
      // or a rebase is the board's own work, which a stop should end
      // rather than leave half done and then publish.
      if (run.role !== "stage") {
        return c.json({ error: "Only a stage's agent can be interrupted. Stop ends this run instead." }, 409);
      }
      const [profile] = await db(c, ctx)
        .select({ cli: agentProfiles.cli })
        .from(agentProfiles)
        .where(eq(agentProfiles.id, run.agentProfileId));
      if (!profile || !interrupts(profile.cli)) {
        return c.json({ error: "This agent cannot be interrupted. Stop ends the run instead." }, 409);
      }
      // Through whichever process holds the run. Held here, the answer
      // is what happened; held elsewhere, it is "requested", and the
      // turn state that process announces next is the rest.
      const outcome = requestRunInterrupt(ctx, run.id);
      return c.json({ interrupted: outcome === "sent" || outcome === "stopped" || outcome === "requested", outcome });
    })
    /**
     * The questions the run's agent is waiting on a person to answer.
     * Empty once the run is no longer running: nothing would read them.
     */
    .get("/:id/questions", async (c) => {
      const found = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      if (found.run.status !== "running") return c.json([]);
      return c.json(await openQuestions(db(c, ctx), found.run.id));
    })
    /**
     * Answers one of the agent's questions. The choice is checked against
     * what was asked (only offered options, one answer for a single
     * choice question, every question answered), stored, and handed to
     * the process holding the run once the row is committed.
     */
    .post(
      "/:id/questions/:questionId/answer",
      zValidator(
        "json",
        z.object({
          answers: z
            .array(
              z.object({
                question: z.string().min(1).max(2000),
                selected: z.array(z.string().max(500)).max(10),
                other: z.string().max(2000).optional(),
              }),
            )
            .min(1)
            .max(10),
        }),
      ),
      async (c) => {
          const found = await getAccessibleRun(ctx, c, c.req.param("id"));
        if (!found) return c.json({ error: "not found" }, 404);
        const [question] = await db(c, ctx)
          .select()
          .from(runQuestions)
          .where(and(eq(runQuestions.id, c.req.param("questionId")), eq(runQuestions.runId, found.run.id)));
        if (!question) return c.json({ error: "not found" }, 404);
        if (question.status !== "pending" || found.run.status !== "running") {
          return c.json({ error: "This question is no longer waiting for an answer." }, 409);
        }
        const body = c.req.valid("json");
        const result = answersFor(question.questions, body.answers);
        if ("error" in result) return c.json({ error: result.error }, 400);
        if (!(await storeAnswer(db(c, ctx), question.id, result.answers, actor(c)))) {
          return c.json({ error: "This question is no longer waiting for an answer." }, 409);
        }
        const runId = found.run.id;
        deferAfterCommit(c, async () => nudgeRun(ctx, runId));
        return c.json({ answered: true, answers: result.answers });
      },
    )
    /**
     * Undoes a run by restoring the sandbox to the snapshot taken before
     * it started. Only available where the driver supports snapshots,
     * and only for finished runs: rolling back under a live agent would
     * race its writes.
     */
    .post("/:id/rollback", async (c) => {
      const found = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      const run = found.run;
      if (!TERMINAL.has(run.status)) return c.json({ error: "wait for the run to finish first" }, 409);
      if (!run.checkpointId) return c.json({ error: "this run has no snapshot to roll back to" }, 400);

      const [sandbox] = await db(c, ctx)
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.id, run.sandboxId ?? ""))
        .limit(1);
      const [feature] = await db(c, ctx).select().from(features).where(eq(features.id, run.featureId));
      const externalId = sandbox?.externalId ?? (feature ? `bento-${feature.id}` : "");
      if (!externalId) return c.json({ error: "no sandbox to roll back" }, 409);

      let driver: SandboxDriver;
      try {
        driver = sandbox ? driverForSandbox(ctx.drivers, sandbox, ctx) : ctx.drivers.default;
      } catch (err) {
        if (!(err instanceof SandboxDriverUnavailable)) throw err;
        // The driver was never asked to restore. "Does not support
        // rollback" would name a capability the missing driver might
        // have had. Name the provider that was asked.
        return c.json({ error: err.message }, 501);
      }
      if (!driver.restore) {
        return c.json({ error: `${driver.provider} sandboxes do not support rollback` }, 501);
      }

      try {
        const network = driver.provider === "modal"
          ? await (async () => {
              const [profile] = await db(c, ctx)
                .select({ cli: agentProfiles.cli, model: agentProfiles.model })
                .from(agentProfiles)
                .where(eq(agentProfiles.id, run.agentProfileId))
                .limit(1);
              if (!profile || !feature) {
                throw new Error("no sandbox to roll back");
              }
              return modalNetworkForProject(
                ctx,
                feature.projectId,
                feature.organizationId,
                profile.cli,
                profile.model,
                run.startedBy,
                run.personalCredentialIds,
              );
            })()
          : {};
        await driver.restore(
          {
            externalId,
            provider: driver.provider,
            workdir: sandbox?.workdir ?? "/workspace",
            ...network,
          },
          run.checkpointId,
        );
        // A stopped Modal machine is booted again here. The row was
        // still hibernated, which neither the hibernate job nor the
        // sweep will touch, so the new machine would run until the
        // 24 hour cap. Ready plus a later job puts it back on the
        // same path as a run that just finished.
        if (driver.provider === "modal" && sandbox) {
          await markSandboxAwake(db(c, ctx), ctx, sandbox.id);
        }
      } catch (err) {
        ctx.analytics?.captureException(err, actor(c), run.organizationId, {
          run_id: run.id,
          source: "sandbox_rollback",
        });
        return c.json({ error: `the sandbox could not be restored (${String(err)}). The run's work may be partly in place, so check the card's changes before retrying` }, 502);
      }

      // The filesystem went back, so the gate decision made from it is
      // stale: re-evaluate rather than leaving the card showing checks
      // that passed against code no longer there.
      await ctx.boss.send("gate.evaluate", { featureId: run.featureId });
      return c.json({ ok: true, restoredTo: run.checkpointId });
    })
    /**
     * Plain-text transcript for clients that cannot parse JSON or hold
     * SSE connections (the TUI's full transcript view reads this). Line 1 is
     * "cursor|<lastSeq>|<runStatus>"; following lines are rendered
     * events after ?since=<seq>.
     */
    .get("/:id/transcript", async (c) => {
      const runId = c.req.param("id");
      const since = Number(c.req.query("since") ?? 0);
      const found = await getAccessibleRunOutput(ctx, c, runId);
      if (!found) return c.text("cursor|0|not_found", 404);
      if (found.swarm && await requireSwarms(ctx, c, found.swarm.organizationId)) return c.text("cursor|0|not_found", 404);
      const run = found.run;

      const rows = await db(c, ctx)
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, since)))
        .orderBy(asc(runEvents.seq));
      const [speakerProfile] = await db(c, ctx)
        .select({ name: agentProfiles.name })
        .from(agentProfiles)
        .where(eq(agentProfiles.id, run.agentProfileId))
        .limit(1);
      // Newlines and pipes would break the line protocol this feeds.
      const agentName = (speakerProfile?.name ?? "agent").replaceAll(/[\r\n|]+/g, " ");

      const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : since;
      const lines = [`cursor|${lastSeq}|${run.status}`];
      for (const row of rows) {
        const ev = row.payload as {
          type: string;
          role?: string;
          text?: string;
          name?: string;
          phase?: string;
          ok?: boolean;
          error?: string;
          costUsd?: number;
          interrupted?: boolean;
        };
        if (ev.type === "message") {
          // The profile's name, not the wire role: "Product Designer>"
          // reads as a colleague, "assistant>" reads as a protocol.
          const speaker = ev.role === "assistant" ? agentName : ev.role === "user" ? "you" : (ev.role ?? "agent");
          for (const line of (ev.text ?? "").split("\n")) lines.push(`${speaker}> ${line}`);
        } else if (ev.type === "tool") {
          lines.push(`[tool ${ev.name ?? "?"} ${ev.phase ?? ""}]`);
        } else if (ev.type === "init") {
          lines.push(`[session started]`);
        } else if (ev.type === "result") {
          lines.push(
            ev.ok
              ? `[done${ev.costUsd !== undefined ? ` cost $${ev.costUsd}` : ""}]`
              : ev.interrupted
                ? "[turn stopped]"
                : `[failed: ${ev.error ?? "no reason reported; see the lines above"}]`,
          );
        }
      }
      return c.text(lines.join("\n"));
    })
    /**
     * A page of a run's events before a sequence number, oldest first:
     * what the conversation route left out of a long run's block. The
     * answer carries where the page begins and how many lines still
     * precede it, so a client can keep asking until there are none.
     */
    .get("/:id/events/before", async (c) => {
      const runId = c.req.param("id");
      const found = await getAccessibleRunOutput(ctx, c, runId);
      if (!found || (found.swarm && await requireSwarms(ctx, c, found.swarm.organizationId))) return c.json({ error: "not found" }, 404);
      const before = Number(c.req.query("seq"));
      if (!Number.isInteger(before) || before < 1) return c.json({ error: "seq must be a positive integer" }, 400);
      const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 500);
      const page = await db(c, ctx)
        .select({ seq: runEvents.seq, payload: runEvents.payload, ts: runEvents.ts })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), lt(runEvents.seq, before)))
        .orderBy(desc(runEvents.seq))
        .limit(limit);
      page.reverse();
      const firstSeq = page[0]?.seq ?? null;
      const earlierRows = firstSeq === null || firstSeq <= 1
        ? []
        : await db(c, ctx)
            .select({ earlier: sql<number>`count(*)::int` })
            .from(runEvents)
            .where(and(eq(runEvents.runId, runId), lt(runEvents.seq, firstSeq)));
      const earlier = earlierRows[0]?.earlier ?? 0;
      return c.json({ events: page.map(recordedRunEvent), firstSeq, earlier });
    })
    /**
     * SSE stream of a run's events. Replays persisted events after
     * ?since=<seq>, then stays live until the run reaches a terminal
     * status. Event data is the run_events row shape.
     *
     * Reconnects resume rather than restart: every frame carries its
     * seq as the SSE id, so EventSource sends Last-Event-ID when it
     * reopens the stream (after a deploy or a network drop), and the
     * replay below starts from there. Honouring it is what keeps a
     * reconnect from replaying the whole run (every message twice) or
     * skipping whatever fired while the socket was down.
     */
    .get("/:id/events", async (c) => {
      const runId = c.req.param("id");
      const sinceParam = Number(c.req.query("since") ?? 0);
      const lastEventId = Number(c.req.header("Last-Event-ID") ?? 0);
      const since = Math.max(
        Number.isFinite(sinceParam) ? sinceParam : 0,
        Number.isFinite(lastEventId) ? lastEventId : 0,
      );
      const found = await getAccessibleRunOutput(ctx, c, runId);
      if (!found || (found.swarm && await requireSwarms(ctx, c, found.swarm.organizationId))) return c.json({ error: "not found" }, 404);

      return streamSSE(c, async (stream) => {
        let lastSeq = since;
        /**
         * Streaming is push based: the orchestrator already publishes
         * every event to the bus as it persists it, so a stream needs
         * the database exactly once, for replay.
         *
         * The previous version polled run status every second per
         * viewer, which cost a query per second per open stream and
         * delayed agent output by up to a second even though the event
         * was already in hand.
         */
        const queue: ({ seq: number; event: unknown } | { delta: AgentDelta } | { turn: TurnState })[] = [];
        let finished: string | null = null;
        let wake: (() => void) | null = null;
        const nudge = () => {
          wake?.();
          wake = null;
        };

        // Subscribe before replaying so nothing falls between the two.
        const unsubscribeEvents = ctx.bus.onRunEvent(runId, (envelope) => {
          queue.push({ seq: envelope.seq, event: envelope.event });
          nudge();
        });
        // One queue for both, so a fragment can never overtake the
        // message that finishes it. Deltas are live only: nothing is
        // stored, so there is nothing to replay and no seq to carry.
        // Contiguous fragments merge into the queue's tail at enqueue
        // time: per token frames were one awaited socket write each,
        // and a viewer on a slow link let the backlog grow at token
        // rate. The merge is safe by construction, because the
        // client's contiguity check accepts a merged fragment exactly
        // as it accepts the run of small ones.
        const unsubscribeDeltas = ctx.bus.onRunDelta(runId, (delta) => {
          const tail = queue[queue.length - 1];
          if (
            tail
            && "delta" in tail
            && tail.delta.channel === delta.channel
            && delta.offset === tail.delta.offset + tail.delta.text.length
          ) {
            tail.delta = { ...tail.delta, text: tail.delta.text + delta.text };
          } else {
            queue.push({ delta });
          }
          nudge();
        });
        // Whether the agent is in a turn, from the process holding the
        // run; live only, like a delta, and in the same queue so it
        // never overtakes the result that ended the turn.
        const unsubscribeTurns = ctx.bus.onRunTurn(runId, (turn) => {
          queue.push({ turn });
          nudge();
        });
        const unsubscribeDone = ctx.bus.onRunDone(runId, (status) => {
          finished = status;
          nudge();
        });
        // The replication listener reconnected, so events emitted on
        // another machine may have passed unheard. The loop answers
        // with the same catch-up query the stream runs at open. This
        // is the one exception to "the database exactly once", and it
        // fires only after a LISTEN outage, never on a timer.
        let needResync = false;
        const unsubscribeResync = ctx.bus.onResync(() => {
          needResync = true;
          nudge();
        });

        try {
          const replay = await db(c, ctx)
            .select()
            .from(runEvents)
            .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, since)))
            .orderBy(asc(runEvents.seq));
          for (const row of replay) {
            await stream.writeSSE({ event: "run_event", id: String(row.seq), data: JSON.stringify(recordedRunEvent(row)) });
            lastSeq = row.seq;
          }

          /**
           * The in-flight message so far, as one offset zero fragment.
           * Without it, a viewer arriving mid message has no draft
           * until the next message starts: the fragments it missed are
           * gone by design, so the whole is sent instead.
           *
           * Read after the replay, in the same synchronous stretch as
           * the write. A snapshot taken before the replay went stale
           * during it: when the message finished mid replay, the
           * replay delivered the persisted copy, and the stale draft
           * then arrived as a phantom duplicate that nothing cleared,
           * because the clearing event had already been consumed as
           * replay. Fragments queued between here and the drain below
           * continue exactly where this snapshot ends, so the client's
           * contiguity check accepts them.
           */
          const draft = ctx.bus.runDraft(runId);
          if (draft) {
            await stream.writeSSE({
              event: "run_delta",
              data: JSON.stringify({ channel: "text", text: draft, offset: 0 } satisfies AgentDelta),
            });
          }

          const turn = ctx.bus.runTurn(runId);
          if (turn) await stream.writeSSE({ event: "run_turn", data: JSON.stringify({ state: turn }) });

          // A run that already ended before we subscribed has no further
          // events coming, so check its status once rather than waiting.
          const [current] = await db(c, ctx)
            .select({ status: agentRuns.status })
            .from(agentRuns)
            .where(eq(agentRuns.id, runId));
          if (!current || TERMINAL.has(current.status)) {
            await stream.writeSSE({ event: "done", data: JSON.stringify({ status: current?.status ?? "unknown" }) });
            return;
          }

          while (true) {
            while (queue.length > 0) {
              const item = queue.shift()!;
              if ("delta" in item) {
                await stream.writeSSE({ event: "run_delta", data: JSON.stringify(item.delta) });
                continue;
              }
              if ("turn" in item) {
                await stream.writeSSE({ event: "run_turn", data: JSON.stringify({ state: item.turn }) });
                continue;
              }
              if (item.seq <= lastSeq) continue;
              await stream.writeSSE({ event: "run_event", id: String(item.seq), data: JSON.stringify(item.event) });
              lastSeq = item.seq;
            }
            if (needResync && !finished) {
              needResync = false;
              const missed = await db(c, ctx)
                .select()
                .from(runEvents)
                .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, lastSeq)))
                .orderBy(asc(runEvents.seq));
              for (const row of missed) {
                await stream.writeSSE({ event: "run_event", id: String(row.seq), data: JSON.stringify(recordedRunEvent(row)) });
                lastSeq = row.seq;
              }
              // The run may have ended while this process was deaf,
              // and the run_done that says so is not replayable.
              const [now] = await db(c, ctx)
                .select({ status: agentRuns.status })
                .from(agentRuns)
                .where(eq(agentRuns.id, runId));
              if (!now || TERMINAL.has(now.status)) finished = now?.status ?? "unknown";
              // Queued live events may now be stale duplicates of the
              // replay above; the seq guard at the top of the drain
              // already discards them, so loop rather than sleep.
              continue;
            }
            if (finished) {
              await stream.writeSSE({ event: "done", data: JSON.stringify({ status: finished }) });
              return;
            }
            if (stream.aborted || stream.closed) return;

            // Sleep until something arrives. The timeout is only a
            // keepalive for proxies that drop idle connections; it
            // touches the socket, never the database.
            await new Promise<void>((resolve) => {
              wake = resolve;
              setTimeout(() => {
                if (wake === resolve) {
                  wake = null;
                  resolve();
                }
              }, 25_000);
            });
            if (!finished && queue.length === 0) {
              await stream.writeSSE({ event: "keepalive", data: "" });
            }
          }
        } finally {
          unsubscribeEvents();
          unsubscribeDeltas();
          unsubscribeTurns();
          unsubscribeDone();
          unsubscribeResync();
        }
      });
    });
}

export function boardEventRoutes(ctx: AppContext) {
  return new Hono().get("/:id/events", async (c) => {
    const projectId = c.req.param("id");
    if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
    // Push based, like the run stream: this never touches the database
    // and never wakes on a timer except to keep the socket alive.
    return streamSSE(c, async (stream) => {
      let open = true;
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const nudge = () => {
        wake?.();
        wake = null;
      };

      const unsubscribe = ctx.bus.onBoardEvent(projectId, (event) => {
        queue.push(event);
        nudge();
      });
      stream.onAbort(() => {
        open = false;
        nudge();
      });

      try {
        while (open) {
          while (queue.length > 0) {
            await stream.writeSSE({ event: "board_event", data: JSON.stringify(queue.shift()) });
          }
          if (!open) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(() => {
              if (wake === resolve) {
                wake = null;
                resolve();
              }
            }, 25_000);
          });
          if (open && queue.length === 0) await stream.writeSSE({ event: "keepalive", data: "" });
        }
      } finally {
        unsubscribe();
      }
    });
  });
}

/** Whether this tool can stop a turn and keep its session (see LiveSession.interrupts). */
function interrupts(cli: string): boolean {
  try {
    return getAdapter(cli as AgentCli).live?.interrupts === true;
  } catch {
    return false;
  }
}
