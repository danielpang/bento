import { zValidator } from "@hono/zod-validator";
import { asc, eq, gt, and } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AgentDelta } from "@bento/core";
import { agentProfiles, agentRuns, features, projects, runEvents, sandboxes, stages } from "@bento/db";
import type { AppContext } from "../context.js";
import { tenantDb as db } from "../middleware/tenant.js";
import { actor } from "../middleware/actor.js";
import { markCancelled } from "../orchestrator/run-executor.js";
import { CARD_BUSY, startRunIfIdle } from "../orchestrator/start-run.js";
import { canAccessProject, getAccessibleFeature, getAccessibleRun } from "../access.js";

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
      const [[stage], [profile]] = await Promise.all([
        db(c, ctx).select().from(stages).where(eq(stages.id, stageId)).limit(1),
        db(c, ctx).select().from(agentProfiles).where(eq(agentProfiles.id, body.agentProfileId)).limit(1),
      ]);
      if (!stage || stage.pipelineId !== feature.pipelineId) return c.json({ error: "stage not found" }, 404);
      if (!profile) return c.json({ error: "agent profile not found" }, 404);

      const [project] = await db(c, ctx).select().from(projects).where(eq(projects.id, feature.projectId));
      const executor = project?.executor ?? "server";

      const run = await startRunIfIdle(db(c, ctx), {
        featureId: feature.id,
        stageId,
        agentProfileId: body.agentProfileId,
        prompt: body.prompt ?? "",
        cliSessionId: body.resumeSessionId ?? null,
        executor,
        startedBy: actor(c),
      }, ctx.entitlements);
      if (run === "busy") return c.json({ error: CARD_BUSY }, 409);
      if ("outOfCompute" in run) return c.json({ error: run.outOfCompute, code: "PLAN_LIMIT" }, 402);

      // Runner-executed runs stay queued until a machine claims them.
      if (executor === "server") await ctx.boss.send("run.execute", { runId: run.id });
      return c.json(run, 201);
    })
    .get("/:id", async (c) => {
      const found = await getAccessibleRun(ctx, c, c.req.param("id"));
      if (!found) return c.json({ error: "not found" }, 404);
      return c.json(found.run);
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

      const run = await startRunIfIdle(db(c, ctx), {
        featureId: previous.featureId,
        stageId: previous.stageId,
        agentProfileId: previous.agentProfileId,
        prompt: c.req.valid("json").prompt,
        cliSessionId: previous.cliSessionId,
        executor: previous.executor,
        // The person resuming owns the hours, not whoever started the
        // run being resumed.
        startedBy: actor(c),
      }, ctx.entitlements);
      if (run === "busy") return c.json({ error: CARD_BUSY }, 409);
      if ("outOfCompute" in run) return c.json({ error: run.outOfCompute, code: "PLAN_LIMIT" }, 402);
      if (previous.executor === "server") await ctx.boss.send("run.execute", { runId: run.id });
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

      ctx.running.get(run.id)?.abort();
      await markCancelled(ctx, run.id);
      ctx.bus.emitBoardEvent({
        type: "run_updated",
        projectId: found.feature.projectId,
        featureId: found.feature.id,
        runId: run.id,
        status: "cancelled",
      });
      const [updated] = await db(c, ctx).select().from(agentRuns).where(eq(agentRuns.id, run.id));
      return c.json(updated);
    })
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
      if (!ctx.driver.restore) {
        return c.json({ error: `${ctx.driver.provider} sandboxes do not support rollback` }, 501);
      }

      const [sandbox] = await db(c, ctx)
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.id, run.sandboxId ?? ""))
        .limit(1);
      const [feature] = await db(c, ctx).select().from(features).where(eq(features.id, run.featureId));
      const externalId = sandbox?.externalId ?? (feature ? `bento-${feature.id}` : "");
      if (!externalId) return c.json({ error: "no sandbox to roll back" }, 409);

      try {
        await ctx.driver.restore(
          { externalId, provider: ctx.driver.provider, workdir: sandbox?.workdir ?? "/workspace" },
          run.checkpointId,
        );
      } catch (err) {
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
     * SSE connections (the Native SDK Mac app polls this). Line 1 is
     * "cursor|<lastSeq>|<runStatus>"; following lines are rendered
     * events after ?since=<seq>.
     */
    .get("/:id/transcript", async (c) => {
      const runId = c.req.param("id");
      const since = Number(c.req.query("since") ?? 0);
      const found = await getAccessibleRun(ctx, c, runId);
      if (!found) return c.text("cursor|0|not_found", 404);
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
          lines.push(ev.ok ? `[done${ev.costUsd !== undefined ? ` cost $${ev.costUsd}` : ""}]` : `[failed: ${ev.error ?? "no reason reported; see the lines above"}]`);
        }
      }
      return c.text(lines.join("\n"));
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
      if (!(await getAccessibleRun(ctx, c, runId))) return c.json({ error: "not found" }, 404);

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
        const queue: ({ seq: number; event: unknown } | { delta: AgentDelta })[] = [];
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
        const unsubscribeDone = ctx.bus.onRunDone(runId, (status) => {
          finished = status;
          nudge();
        });

        try {
          const replay = await db(c, ctx)
            .select()
            .from(runEvents)
            .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, since)))
            .orderBy(asc(runEvents.seq));
          for (const row of replay) {
            await stream.writeSSE({ event: "run_event", id: String(row.seq), data: JSON.stringify(row.payload) });
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
              if (item.seq <= lastSeq) continue;
              await stream.writeSSE({ event: "run_event", id: String(item.seq), data: JSON.stringify(item.event) });
              lastSeq = item.seq;
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
          unsubscribeDone();
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
