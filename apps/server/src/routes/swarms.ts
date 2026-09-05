import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { SandboxHandle } from "@bento/sandbox";
import {
  agentRuns,
  ensureSwarmAgents,
  projects,
  sandboxes,
  swarmLandings,
  swarmMessages,
  swarmTasks,
  swarmTemplates,
  swarms,
} from "@bento/db";
import {
  canAccessProject,
  getAccessibleSwarm,
  getAccessibleSwarmTemplate,
  getActiveOrganizationMembership,
  visibleProjectFilter,
} from "../access.js";
import type { AppContext } from "../context.js";
import type { BoardEvent } from "../events.js";
import { actor } from "../middleware/actor.js";
import { deferAfterCommit, tenantDb as db } from "../middleware/tenant.js";
import { markCancelled } from "../orchestrator/run-executor.js";
import { enqueueSwarmTick } from "../orchestrator/swarm/coordinator.js";
import { requireSwarms } from "../orchestrator/swarm/gate.js";
import { swarmBranchName } from "../orchestrator/swarm/sandbox.js";
import { ACTIVE_RUN_STATUSES, startRunIfIdle } from "../orchestrator/start-run.js";
import { enqueueRun } from "../orchestrator/queue.js";

/**
 * The swarm board's routes.
 *
 * Every handler resolves its swarm through getAccessibleSwarm and
 * answers 404 for anything else, the same convention as the card
 * routes: not yours reads as not there, so a probe cannot learn that an
 * id exists. The swarm gate goes first and answers 404 as well, so a
 * person who is not a beta tester cannot tell that swarms exist at all.
 */

/**
 * Why a swarm cannot be created on this project.
 *
 * A runner project's runs execute on a machine the team owns, and the
 * server only hands out work and takes reports back. A swarm needs the
 * opposite: the coordinator holds the sandboxes, because landing one
 * worker's branch onto the swarm's branch is a git operation in a
 * checkout it has to be holding, and the runner protocol has no verb
 * for it. This is a decision, not a gap to fill in later: a swarm on a
 * runner project would need a second merge queue that lives on the
 * runner, which is a different product.
 */
export const RUNNER_PROJECT_REFUSAL =
  "Swarms need Bento to hold the sandboxes, because the merge queue lands one branch onto another inside them. This project runs its agents on your own machines, so it cannot run a swarm. Use a card, or move the project to server-run agents.";

const createSwarm = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  goal: z.string().max(20_000).default(""),
  templateId: z.string().uuid().nullish(),
  maxWorkers: z.number().int().min(1).max(32).optional(),
  budgetUsd: z.number().min(0).max(100_000).nullish(),
  timeLimitMin: z.number().int().min(1).max(60 * 24 * 7).nullish(),
});

/**
 * What a person may change about a swarm: what it is called, what it
 * was asked to do, its ceilings, and whether it is put away.
 *
 * Deliberately not its status. Where a swarm is in its life is decided
 * by the routes below, which is where the rules about it live: /start
 * refuses a swarm with no plan and one that is over, and pausing
 * records why it is paused. A status accepted here walked past all of
 * that, so a PATCH could resurrect a cancelled swarm and set the
 * reconciler on it again.
 */
const updateSwarm = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    goal: z.string().max(20_000).optional(),
    maxWorkers: z.number().int().min(1).max(32).optional(),
    budgetUsd: z.number().min(0).max(100_000).nullable().optional(),
    timeLimitMin: z.number().int().min(1).max(60 * 24 * 7).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "nothing to change" });

export function swarmRoutes(ctx: AppContext) {
  return new Hono()
    /**
     * The strip: this project's swarms, newest first, with the numbers
     * a card in a list shows. The tree is not here: a strip that loaded
     * every plan would load every node of every swarm to draw a row.
     */
    .get("/", async (c) => {
      const refusal = await requireSwarms(ctx, c);
      if (refusal) return c.json(refusal.body, refusal.status);
      const projectId = c.req.query("projectId");
      if (projectId) {
        if (!(await canAccessProject(ctx, c, projectId))) return c.json({ error: "not found" }, 404);
      }
      const visible = await visibleProjectFilter(ctx, c);
      const rows = await db(c, ctx)
        .select({
          swarm: swarms,
          tasks: sql<number>`(select count(*)::int from ${swarmTasks} where ${swarmTasks.swarmId} = ${swarms.id})`,
          done: sql<number>`(select count(*)::int from ${swarmTasks} where ${swarmTasks.swarmId} = ${swarms.id} and ${swarmTasks.status} = 'done')`,
          attention: sql<number>`(select count(*)::int from ${swarmTasks} where ${swarmTasks.swarmId} = ${swarms.id} and ${swarmTasks.attention} is not null)`,
        })
        .from(swarms)
        .innerJoin(projects, eq(projects.id, swarms.projectId))
        .where(and(visible, projectId ? eq(swarms.projectId, projectId) : undefined))
        .orderBy(desc(swarms.createdAt));
      return c.json(
        rows.map((row) => ({ ...row.swarm, counts: { tasks: row.tasks, done: row.done, attention: row.attention } })),
      );
    })
    /**
     * Starts a swarm off, in the planning state, and puts its planner
     * to work at once.
     *
     * The planner's first run is started here rather than by the
     * coordinator, because the coordinator's job is to react to rows
     * and at this moment there is nothing to react to: no tasks, no
     * reports, no messages. What there is, is a goal somebody just
     * wrote, which is exactly the planner's opening prompt.
     */
    .post("/", zValidator("json", createSwarm), async (c) => {
      const body = c.req.valid("json");
      const [project] = await db(c, ctx).select().from(projects).where(eq(projects.id, body.projectId));
      if (!project || !(await canAccessProject(ctx, c, project.id))) {
        return c.json({ error: "not found" }, 404);
      }
      // The gate is asked about the team whose project this is, rather
      // than whichever tab the caller has open.
      const refusal = await requireSwarms(ctx, c, project.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      if (project.executor === "runner") {
        return c.json({ error: RUNNER_PROJECT_REFUSAL, code: "RUNNER_PROJECT" }, 400);
      }

      const membership = await getActiveOrganizationMembership(ctx, c);
      const template = body.templateId
        ? await getAccessibleSwarmTemplate(ctx, c, body.templateId)
        : await defaultTemplate(ctx, c, project.organizationId);
      if (!template) return c.json({ error: "not found" }, 404);
      if (!template.plannerProfileId) {
        return c.json(
          { error: "This swarm template has no planner agent, so there is nobody to write the plan. Choose one under Swarm templates." },
          400,
        );
      }
      if (ctx.env.BENTO_MODE === "multi" && project.organizationId && !membership) {
        return c.json({ error: "not found" }, 404);
      }

      const slug = await uniqueSlug(ctx, c, project.id, body.title);
      const [swarm] = await db(c, ctx)
        .insert(swarms)
        .values({
          projectId: project.id,
          slug,
          title: body.title,
          goal: body.goal,
          templateId: template.id,
          // Planning, not draft: the planner starts below, and a person
          // watching should see that rather than a swarm that looks
          // like it is waiting for them.
          status: "planning",
          branchName: swarmBranchName(slug),
          maxWorkers: body.maxWorkers ?? template.maxWorkers,
          budgetUsd:
            body.budgetUsd === undefined
              ? template.budgetUsd
              : body.budgetUsd === null
                ? null
                : String(body.budgetUsd),
          timeLimitMin: body.timeLimitMin === undefined ? template.timeLimitMin : body.timeLimitMin ?? null,
          startedBy: actor(c),
        })
        .returning();
      if (!swarm) return c.json({ error: "something went wrong starting the swarm; try again" }, 500);

      const run = await startRunIfIdle(
        db(c, ctx),
        {
          type: "swarm" as const,
          swarmId: swarm.id,
          role: "planner",
          agentProfileId: template.plannerProfileId,
          // Empty, so the executor builds the planner's own opening
          // prompt: it needs the checkout paths, which do not exist
          // until the sandbox does.
          prompt: "",
          executor: "server",
          startedBy: actor(c),
        },
        ctx.entitlements,
        ctx.analytics,
        (task) => deferAfterCommit(c, async () => task()),
      );
      if (run === "gone") return c.json({ error: "not found" }, 404);
      if (run !== "busy" && "outOfCompute" in run) {
        return c.json({ error: run.outOfCompute, code: "PLAN_LIMIT" }, 402);
      }
      if (run !== "busy") {
        deferAfterCommit(c, async () => {
          await enqueueRun(ctx, run.id);
        });
      }
      return c.json({ ...swarm, plannerRunId: run === "busy" ? null : run.id }, 201);
    })
    /**
     * One swarm with its plan.
     *
     * The tree travels flat, with each node naming its parent. It is
     * the same tree either way, and a flat list is what a client can
     * re-render from one event without rebuilding a nested structure it
     * would then have to diff.
     */
    .get("/:id", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      const tasks = await db(c, ctx)
        .select()
        .from(swarmTasks)
        .where(eq(swarmTasks.swarmId, swarm.id))
        .orderBy(asc(swarmTasks.position), asc(swarmTasks.createdAt));
      const runs = await db(c, ctx)
        .select({
          id: agentRuns.id,
          role: agentRuns.role,
          status: agentRuns.status,
          swarmTaskId: agentRuns.swarmTaskId,
          queuedAt: agentRuns.queuedAt,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .orderBy(desc(agentRuns.queuedAt));
      return c.json({ swarm, tasks, activeRuns: runs });
    })
    .patch("/:id", zValidator("json", updateSwarm), async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      const body = c.req.valid("json");

      const { budgetUsd, archived, ...rest } = body;
      const [updated] = await db(c, ctx)
        .update(swarms)
        .set({
          ...rest,
          ...(budgetUsd === undefined ? {} : { budgetUsd: budgetUsd === null ? null : String(budgetUsd) }),
          ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
          updatedAt: new Date(),
        })
        .where(eq(swarms.id, swarm.id))
        .returning();
      /*
       * Raising the ceiling is a change the reconciler has to act on:
       * there may be leaves waiting for a worker slot it refused when
       * the ceiling was lower. Lowering it takes effect as workers
       * finish; nothing is killed mid task.
       */
      if (rest.maxWorkers !== undefined) deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      return c.json(updated);
    })
    /**
     * Pauses a swarm, and says a person did it.
     *
     * Its own route rather than a status a client patches, because
     * what "paused" means here is two writes that have to agree: the
     * status, and why. The reason is what tells the board whether
     * resuming is a button or a plan change, and a swarm paused
     * without one reads as paused for a reason nobody recorded.
     *
     * Nothing already running is killed. A worker finishes its leaf and
     * reports; what pausing stops is the next one starting, which the
     * coordinator decides by reading this status.
     */
    .post("/:id/pause", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      if (swarm.status === "done" || swarm.status === "cancelled") {
        return c.json({ error: `This swarm is ${swarm.status}, so there is nothing to pause.` }, 409);
      }
      const [paused] = await db(c, ctx)
        .update(swarms)
        .set({ status: "paused", pausedReason: "manual", updatedAt: new Date() })
        .where(eq(swarms.id, swarm.id))
        .returning();
      return c.json(paused);
    })
    /**
     * Stops a swarm for good, agents included.
     *
     * Separate from pausing because it is a different decision, and it
     * is the stronger one in both directions. Pausing lets the workers
     * that are mid task finish; cancelling stops them where they are,
     * because a person who pressed stop is not asking to keep paying
     * for the turn in flight. Its rows stay, so what it did and what
     * it cost is still readable.
     */
    .post("/:id/cancel", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      if (swarm.status === "done") {
        return c.json({ error: "This swarm is done, so there is nothing to stop." }, 409);
      }
      const now = new Date();
      /*
       * The status lands first, and the runs are stopped after it. That
       * order is the whole safety of this route. Both of the
       * reconciler's spawn steps read this status (a cancelled swarm
       * wakes no planner and is given no worker), and a tick takes the
       * swarm row's lock before it reads anything, so once this update
       * holds that lock a concurrent tick either waited for it and then
       * spawns nothing, or already held it and whatever it started is
       * queued or running by now, which is exactly what the query below
       * looks for. Stopping the runs first would leave that second tick
       * free to put a fresh agent on a swarm that was still running
       * when it looked, and the person's stop would have killed one run
       * and started another.
       */
      const [cancelled] = await db(c, ctx)
        .update(swarms)
        .set({ status: "cancelled", pausedReason: null, updatedAt: now })
        .where(eq(swarms.id, swarm.id))
        .returning();

      /*
       * The merge queue goes with it, in the same transaction as the
       * status, because it is the same decision: a landing waiting its
       * turn, or waiting for somebody to resolve a conflict, is waiting
       * on a swarm that will never run again, and a queue full of rows
       * that say "queued" reads as work still to come. Landed and
       * failed rows keep the ending they already have, and a landing in
       * flight belongs to whatever is performing it.
       */
      await db(c, ctx)
        .update(swarmLandings)
        .set({ status: "cancelled", endedAt: now, updatedAt: now })
        .where(
          and(eq(swarmLandings.swarmId, swarm.id), inArray(swarmLandings.status, ["queued", "conflicted"])),
        );

      /*
       * And the agents themselves, through the card board's own
       * cancellation rather than a second one: markCancelled is a
       * compare-and-set against the active statuses, so a run some
       * other path already ended is not ended twice, and it is what
       * revokes the run's gateway token (an agent that keeps talking
       * finds the swarm tools gone), meters the hours, and tells the
       * streams.
       *
       * A swarm's runs are always this server's (a project on a runner
       * cannot have a swarm at all), but the abort handle lives in the
       * memory of the process carrying the run, so one this process is
       * not carrying is marked rather than interrupted: its token is
       * dead from here, so its tools stop answering, and the finish it
       * eventually writes is refused by the same compare-and-set. A run
       * still queued stops outright, because the executor picks up
       * nothing that is no longer queued.
       */
      const active = await db(c, ctx)
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)));
      for (const run of active) {
        ctx.running.get(run.id)?.abort();
        await markCancelled(ctx, run.id);
      }
      return c.json(cancelled);
    })
    /**
     * Starts the work, once there is a plan to work.
     *
     * Separate from creation on purpose. Creating a swarm starts a
     * planner; this is the person saying the plan is worth running,
     * and until they do, the coordinator spawns nobody. A swarm with an
     * empty tree has nothing to start, and saying so beats starting a
     * swarm that then does nothing.
     *
     * Resuming a paused swarm comes through here too, and gets the
     * same two refusals: there is no second door with its own idea of
     * when a swarm may run.
     */
    .post("/:id/start", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      const [{ count } = { count: 0 }] = await db(c, ctx)
        .select({ count: sql<number>`count(*)::int` })
        .from(swarmTasks)
        .where(and(eq(swarmTasks.swarmId, swarm.id), sql`${swarmTasks.status} <> 'cancelled'`));
      if (count === 0) {
        return c.json(
          { error: "This swarm has no plan yet, so there is nothing to start. Wait for the planner, or send it a message.", code: "NO_PLAN" },
          409,
        );
      }
      if (swarm.status === "cancelled" || swarm.status === "done") {
        return c.json({ error: `This swarm is ${swarm.status}, so it cannot be started.` }, 409);
      }

      const [started] = await db(c, ctx)
        .update(swarms)
        .set({ status: "running", pausedReason: null, updatedAt: new Date() })
        .where(eq(swarms.id, swarm.id))
        .returning();
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      return c.json(started);
    })
    /** The swarm's thread: what people asked, and what agents asked back. */
    .get("/:id/messages", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      const rows = await db(c, ctx)
        .select()
        .from(swarmMessages)
        .where(eq(swarmMessages.swarmId, swarm.id))
        .orderBy(asc(swarmMessages.createdAt));
      return c.json(rows);
    })
    /**
     * Sends a message into the swarm: to the planner by default, or to
     * one node when a task is named.
     *
     * Queued rather than delivered. A headless agent cannot hear mid
     * turn, so the coordinator folds everything waiting into one wake
     * message when the planner is next idle, which is also what makes
     * five answers in a minute one turn rather than five.
     */
    .post(
      "/:id/messages",
      zValidator("json", z.object({ text: z.string().trim().min(1).max(20_000), taskId: z.string().uuid().nullish() })),
      async (c) => {
        const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
        if (!swarm) return c.json({ error: "not found" }, 404);
        const refusal = await requireSwarms(ctx, c, swarm.organizationId);
        if (refusal) return c.json(refusal.body, refusal.status);
        const body = c.req.valid("json");

        if (body.taskId) {
          const [task] = await db(c, ctx)
            .select({ id: swarmTasks.id })
            .from(swarmTasks)
            .where(and(eq(swarmTasks.id, body.taskId), eq(swarmTasks.swarmId, swarm.id)))
            .limit(1);
          if (!task) return c.json({ error: "not found" }, 404);
        }

        const [message] = await db(c, ctx)
          .insert(swarmMessages)
          .values({
            swarmId: swarm.id,
            ...(body.taskId ? { taskId: body.taskId } : {}),
            text: body.text,
            userId: actor(c),
          })
          .returning();
        // An answer is what a swarm waiting on a question was waiting
        // for, so the wait ends here rather than on the next tick.
        if (swarm.pausedReason === "attention") {
          await db(c, ctx).update(swarms).set({ pausedReason: null }).where(eq(swarms.id, swarm.id));
        }
        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        return c.json(message, 201);
      },
    )
    /**
     * Deletes a swarm and everything under it, machines included.
     *
     * Refused while an agent is working, the way a card is: the run
     * would keep going in its sandbox with nothing left to report to,
     * and its machine would be nobody's to reap.
     *
     * The machines go before the rows, and a failure fails the request,
     * which is the card delete's order and its reason. A swarm holds
     * more of them than a card does (its own, and one per leaf), and
     * sandboxes.swarm_id is "set null", so deleting the swarm first
     * left every one of them running and billing with nothing in the
     * product still naming it.
     */
    .delete("/:id", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      const [active] = await db(c, ctx)
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      if (active) {
        return c.json({ error: "Agents are working in this swarm. Pause it and wait for them to stop, then delete." }, 409);
      }

      /*
       * Read whole, destroyed ones included: their rows have to go too,
       * or the delete leaves exactly the pointerless row that is
       * supposed to mean a machine is adrift.
       */
      const owned = await db(c, ctx).select().from(sandboxes).where(eq(sandboxes.swarmId, swarm.id));
      for (const sandbox of owned.filter((row) => row.status !== "destroyed")) {
        const handle: SandboxHandle = {
          externalId: sandbox.externalId,
          provider: sandbox.provider === "sprite" ? "sprite" : ctx.driver.provider,
          workdir: sandbox.workdir,
        };
        try {
          await ctx.driver.destroy(handle);
        } catch (err) {
          return c.json(
            {
              error: `the sandbox could not be destroyed (${err instanceof Error ? err.message : String(err)}). The swarm was not deleted; try again`,
            },
            502,
          );
        }
      }

      await db(c, ctx).delete(swarms).where(eq(swarms.id, swarm.id));
      /*
       * The sandbox rows last, and by id: the delete above has already
       * set their swarm_id to null, so a delete by swarm_id would now
       * match nothing and leave them behind. Explicitly rather than by
       * cascade, because that "set null" is what makes a row deleted
       * outside Bento evidence of a machine still running.
       */
      if (owned.length > 0) {
        await db(c, ctx).delete(sandboxes).where(
          inArray(
            sandboxes.id,
            owned.map((row) => row.id),
          ),
        );
      }
      return c.json({ ok: true });
    })
    /**
     * The live view of one swarm.
     *
     * Two queries at setup and then nothing: the access check, and the
     * snapshot the client renders before the first event. After that
     * every update comes off the in-process bus. There is no polling
     * loop here and there must never be one: a swarm runs for as long
     * as its agents do, and a query per viewer per second is what the
     * card stream was fixed for.
     *
     * Outside the tenant transaction, like every other stream, so it
     * holds no pooled connection while it waits.
     */
    .get("/:id/events", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      const swarmId = swarm.id;
      const projectId = swarm.projectId;

      return streamSSE(c, async (stream) => {
        let open = true;
        const queue: BoardEvent[] = [];
        let wake: (() => void) | null = null;
        const nudge = () => {
          wake?.();
          wake = null;
        };

        /**
         * Both boards' events travel on the project's channel, so this
         * takes the swarm's own out of it. One subscription rather than
         * a channel per swarm: a project has a handful of swarms and an
         * emitter comparison is cheaper than a second bus key.
         */
        const unsubscribe = ctx.bus.onBoardEvent(projectId, (event) => {
          if (!("swarmId" in event) || event.swarmId !== swarmId) return;
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
              await stream.writeSSE({ event: "swarm_event", data: JSON.stringify(queue.shift()) });
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

/**
 * The template a swarm starts from when the caller named none.
 *
 * Created rather than refused, with the seeded planner and worker, for
 * the reason a new project gets a pipeline and six agents: a first
 * swarm should be one form, not a tour of two panels. It is an ordinary
 * template afterwards, editable and deletable like any other.
 */
async function defaultTemplate(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  organizationId: string | null,
) {
  const owner = { ownerId: actor(c), organizationId: ctx.env.BENTO_MODE === "multi" ? organizationId : null };
  const [existing] = await db(c, ctx)
    .select()
    .from(swarmTemplates)
    .where(
      and(
        eq(swarmTemplates.ownerId, owner.ownerId),
        organizationId && ctx.env.BENTO_MODE === "multi"
          ? eq(swarmTemplates.organizationId, organizationId)
          : sql`${swarmTemplates.organizationId} is null`,
        eq(swarmTemplates.name, "Default"),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const agents = await ensureSwarmAgents(db(c, ctx), owner);
  const [created] = await db(c, ctx)
    .insert(swarmTemplates)
    .values({
      ownerId: owner.ownerId,
      organizationId: owner.organizationId,
      name: "Default",
      description: "The planner and worker a swarm uses when nobody has chosen others.",
      plannerProfileId: agents.planner,
      workerProfileId: agents.worker,
    })
    .returning();
  return created ?? null;
}

/**
 * A handle for this swarm inside its project, from its title.
 *
 * It ends up in a branch name and a URL, so it is lowercase, short, and
 * has no characters git would argue about. Uniqueness is per project
 * (the index says so), and a collision takes a numeric suffix rather
 * than a random one: "checkout-rewrite-2" is a thing a person can read
 * in a branch list.
 */
async function uniqueSlug(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  projectId: string,
  title: string,
): Promise<string> {
  const base =
    title
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40) || "swarm";
  const taken = new Set(
    (
      await db(c, ctx)
        .select({ slug: swarms.slug })
        .from(swarms)
        .where(eq(swarms.projectId, projectId))
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // A project with a thousand swarms of one name: the id is unique and
  // legibility has already lost.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}
