import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { SandboxHandle } from "@bento/sandbox";
import {
  agentProfiles,
  agentRuns,
  ensureSwarmAgents,
  projects,
  repositories,
  sandboxes,
  swarmLandings,
  swarmMessages,
  swarmPullRequests,
  swarmTaskEvents,
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
import { queueSwarmSandboxReap } from "../orchestrator/reap-sandbox.js";
import { markCancelled } from "../orchestrator/run-executor.js";
import { enqueueSwarmTick } from "../orchestrator/swarm/coordinator.js";
import { requireSwarms } from "../orchestrator/swarm/gate.js";
import { swarmBranchName } from "../orchestrator/swarm/sandbox.js";
import { workerBranchName } from "../orchestrator/swarm/branches.js";
import { commitsForTask } from "../orchestrator/swarm/landing-git.js";
import { cancelTaskTree, reassignLeaf, retryLeaf, retryRefusal, splitLeaf } from "../orchestrator/swarm/task-actions.js";
import { reopenSwarm, swarmHasActiveRun } from "../orchestrator/swarm/reopen.js";
import { captureSwarmSpend } from "../orchestrator/swarm/spend.js";
import { budgetRefusal } from "../orchestrator/swarm/ledger.js";
import { ACTIVE_RUN_STATUSES, SWARM_FULL, startRunIfIdle } from "../orchestrator/start-run.js";
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

/**
 * How much of the merge queue the detail carries.
 *
 * Enough to answer what a person opens the panel to ask: what is
 * landing now, what is behind it, and did the last few go in. A swarm
 * has a landing per leaf, so the whole list grows without bound and
 * without becoming more useful.
 *
 * Counted per half, because the two halves answer different questions
 * and one cap over both hid the half that matters: the front of the
 * queue is what is happening, and the history is only how a person
 * checks that the queue is moving at all. The console draws ten of
 * that history, so ten is what it is sent.
 */
const LANDINGS_SHOWN = 20;
const LANDINGS_HISTORY = 10;

/**
 * How much of one node's history the drawer is sent.
 *
 * A node that was assigned, reported, rejected and reassigned six
 * times has an event per step, and the drawer is something a person
 * reads rather than a log they page through. The newest are the ones
 * that explain where the node is now.
 */
const TASK_EVENTS_SHOWN = 50;

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
 * What a person may change about a swarm: what it is called, its
 * ceilings, and whether it is put away.
 *
 * The goal is deliberately absent. It is the immutable request the
 * swarm was created from, and changing it in place would rewrite the
 * meaning of every earlier task and run. Further work belongs through
 * the reopen route as a follow-up, where the original request remains
 * visible beside the new instruction.
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

      /*
       * The plan's allowance, asked before anything at all is written.
       *
       * startRunIfIdle asks it again at the door where the planner
       * actually starts, and that door is still the one that decides;
       * this is here because the answer used to arrive after the swarm
       * row had been inserted, so a team over its limit was left
       * holding a swarm it could not start and had not asked for. The
       * organization is the project's, not whichever tab the caller
       * has open.
       */
      if (ctx.entitlements?.canStartRun && project.organizationId) {
        const overLimit = await ctx.entitlements.canStartRun(project.organizationId);
        if (overLimit) return c.json({ error: overLimit.reason, code: "PLAN_LIMIT" }, 402);
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

      const budgetUsd =
        body.budgetUsd === undefined
          ? template.budgetUsd
          : body.budgetUsd === null
            ? null
            : String(body.budgetUsd);
      const budget = budgetRefusal({
        budgetUsd,
        spentMeasuredUsd: "0",
        spentEstimatedUsd: "0",
        spentAssumedUsd: "0",
        spentNotionalUsd: "0",
      });
      if (budget) return c.json({ error: budget, code: "PLAN_LIMIT" }, 402);

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
          budgetUsd,
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
      /*
       * Neither refusal is reachable on a swarm this request just
       * created: nothing else can be planning it, and a worker ceiling
       * is a worker's answer rather than a planner's. Folded together
       * so the swarm still reads back, with no planner run named,
       * rather than turning into a 500 over a case that cannot happen.
       */
      const started = run === "busy" || run === SWARM_FULL ? null : run;
      if (started && "outOfCompute" in started) {
        return c.json({ error: started.outOfCompute, code: "PLAN_LIMIT" }, 402);
      }
      if (started) {
        deferAfterCommit(c, async () => {
          await enqueueRun(ctx, started.id);
        });
      }
      return c.json({ ...swarm, plannerRunId: started?.id ?? null }, 201);
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
      /**
       * The merge queue, as the panel draws it: what is waiting, what
       * is landing, and the last of what has landed.
       *
       * Two queries rather than one, and that is the whole point. A
       * long swarm has a landing per leaf, and one capped query ordered
       * by position hands back the oldest rows: position is monotonic
       * per acceptance, so a swarm on its twenty first leaf sent twenty
       * finished rows and left out the branch that was actually landing
       * and the conflict somebody opened the panel to find. The panel
       * then drew "one branch at a time" over a queue it could not see.
       *
       * So the queue is asked for separately from the history. What has
       * not finished, in the queue's own order and then by when the row
       * was made so two rows sharing a position do not swap between
       * refetches; and the last few that have, newest first. Both
       * capped, because the cap belongs here rather than in the browser:
       * a swarm of two hundred leaves must not send two hundred rows on
       * every refetch.
       */
      const landingColumns = {
        id: swarmLandings.id,
        taskId: swarmLandings.taskId,
        branchName: swarmLandings.branchName,
        position: swarmLandings.position,
        status: swarmLandings.status,
        attempt: swarmLandings.attempt,
        error: swarmLandings.error,
        resolverRunId: swarmLandings.resolverRunId,
        startedAt: swarmLandings.startedAt,
        endedAt: swarmLandings.endedAt,
      };
      const inQueue = await db(c, ctx)
        .select(landingColumns)
        .from(swarmLandings)
        .where(
          and(
            eq(swarmLandings.swarmId, swarm.id),
            inArray(swarmLandings.status, ["landing", "conflicted", "queued"]),
          ),
        )
        .orderBy(asc(swarmLandings.position), asc(swarmLandings.createdAt))
        .limit(LANDINGS_SHOWN);
      const finished = await db(c, ctx)
        .select(landingColumns)
        .from(swarmLandings)
        .where(
          and(
            eq(swarmLandings.swarmId, swarm.id),
            inArray(swarmLandings.status, ["landed", "failed", "cancelled"]),
          ),
        )
        .orderBy(desc(swarmLandings.endedAt), desc(swarmLandings.createdAt))
        .limit(LANDINGS_HISTORY);
      const landings = [...inQueue, ...finished];
      /**
       * What the swarm published, for the chips on the header.
       *
       * Through the tenant-scoped handle like everything else here, so
       * a row somebody else's swarm owns is not reachable by asking for
       * this one. One per repository, so no cap is needed.
       */
      const pullRequests = await db(c, ctx)
        .select({
          id: swarmPullRequests.id,
          repoUrl: swarmPullRequests.repoUrl,
          number: swarmPullRequests.number,
          url: swarmPullRequests.url,
          headSha: swarmPullRequests.headSha,
        })
        .from(swarmPullRequests)
        .where(eq(swarmPullRequests.swarmId, swarm.id))
        .orderBy(asc(swarmPullRequests.createdAt));
      return c.json({ swarm, tasks, activeRuns: runs, landings, pullRequests });
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
       * Raising any ceiling is a change the reconciler has to act on,
       * and for the same reason: there may be leaves waiting for a
       * slot, for money, or for the clock, that it refused when the
       * ceiling was lower. The budget and the time limit matter most,
       * because a swarm that reached either is stopped rather than
       * merely slowed, and nothing else would ever ask again: raising
       * one is a person's decision, not an event this server hears.
       *
       * Lowering either takes effect as workers finish. Nothing is
       * killed mid task, which is the rule every ceiling in a swarm
       * follows.
       *
       * The warning latch goes with a changed budget, because a raised
       * budget is a different budget: running low on it is news again,
       * and a planner that was told once about the old one would never
       * be told about this one.
       */
      const ceilingMoved =
        rest.maxWorkers !== undefined || budgetUsd !== undefined || rest.timeLimitMin !== undefined;
      if (budgetUsd !== undefined) {
        await db(c, ctx).update(swarms).set({ budgetWarnedAt: null }).where(eq(swarms.id, swarm.id));
      }
      if (ceilingMoved) deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
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

      /*
       * And the swarm's own machine, which nothing will work in again.
       * Queued rather than destroyed inline, the way a finished card's
       * is: the provider is a network call away and stopping a swarm
       * must not fail because Fly was slow. After the commit, so the
       * reap reads the cancelled runs rather than the active ones it
       * would refuse to reap under.
       */
      deferAfterCommit(c, () => queueSwarmSandboxReap(ctx, swarm.id));
      /*
       * And what it cost, because a swarm somebody stopped is one of
       * the more interesting things to know the spend of: it is the
       * shape of a swarm that was not converging. After the commit, so
       * the figures the event reads are the ones this request wrote.
       */
      deferAfterCommit(c, () => captureSwarmSpend(ctx, swarm.id, "cancelled"));
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
    /**
     * Takes a finished swarm up again with a follow up.
     *
     * Its own route rather than a start with an instruction on it,
     * because it is a different thing: /start is a person saying a
     * plan is worth running, and this adds work to a swarm that has
     * already finished and published. What it must not do is give the
     * swarm a new branch, which is the whole reason it exists: the
     * pull requests already open on that branch are updated by the
     * publish at the end, and a second branch would mean a second pull
     * request over the same change.
     *
     * The rules live in reopen.ts, shared with anything else that
     * reopens a swarm, and both ceilings are refused before anything
     * is written: a swarm put back to "running" that the coordinator
     * then refuses to spawn on is a board that says it is working and
     * never moves.
     */
    .post(
      "/:id/reopen",
      zValidator(
        "json",
        z
          .object({
            instruction: z.string().trim().min(1).max(20_000),
            budgetUsd: z.number().min(0).max(100_000).nullable().optional(),
            timeLimitMin: z.number().int().min(1).max(60 * 24 * 7).nullable().optional(),
          })
          .strict(),
      ),
      async (c) => {
        const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
        if (!swarm) return c.json({ error: "not found" }, 404);
        const refusal = await requireSwarms(ctx, c, swarm.organizationId);
        if (refusal) return c.json(refusal.body, refusal.status);
        const body = c.req.valid("json");

        /*
         * A swarm whose last agent has not settled yet is one the
         * coordinator is still about to hear from, and its report
         * would land on a tree this request is about to change under
         * it. Waiting a moment is the whole fix.
         */
        if (await swarmHasActiveRun(db(c, ctx), swarm.id)) {
          return c.json(
            {
              error: "An agent from this swarm is still finishing. Wait for it to stop, then reopen.",
              code: "SWARM_BUSY",
            },
            409,
          );
        }

        const reopened = await reopenSwarm(db(c, ctx), swarm, {
          instruction: body.instruction,
          ...(body.budgetUsd === undefined ? {} : { budgetUsd: body.budgetUsd }),
          ...(body.timeLimitMin === undefined ? {} : { timeLimitMin: body.timeLimitMin }),
          actorUserId: actor(c),
        });
        if ("refused" in reopened) return c.json({ error: reopened.refused, code: reopened.code }, 409);

        // The planner hears the instruction through the wake the tick
        // delivers, which is the same door every other message uses.
        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        return c.json({ swarm: reopened.swarm, followUpTaskId: reopened.followUpTaskId, followUp: reopened.followUp }, 201);
      },
    )
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
     * One node, in the detail the drawer needs and the plan does not
     * carry: what was committed for it, and what has happened to it.
     *
     * Its own route rather than fields on the plan. The commits are
     * read out of git by grepping a branch for the task's trailer, so
     * a plan of two hundred nodes on a project spanning three
     * repositories would be six hundred git processes per refetch, for
     * a list nobody is looking at until they open one node. The
     * drawer asks for the node it opened.
     */
    .get("/:id/tasks/:taskId", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      // Scoped to this swarm, so a task id from another team's swarm
      // reads as not there rather than as one this caller may not read.
      const [task] = await db(c, ctx)
        .select()
        .from(swarmTasks)
        .where(and(eq(swarmTasks.id, c.req.param("taskId")), eq(swarmTasks.swarmId, swarm.id)))
        .limit(1);
      if (!task) return c.json({ error: "not found" }, 404);

      /**
       * What has happened to this node, resolver runs included.
       *
       * The events are already written by everything that touches a
       * task: the planner creating and assigning it, the queue raising
       * a conflict and putting an agent on it, the landing that
       * finished it. `runId` is what makes a resolver legible here,
       * because it is the only record on the node itself that an agent
       * other than its worker was ever on it.
       *
       * Newest last, capped: a node that has been retried all day is
       * still a drawer somebody scrolls, not a log.
       */
      const events = await db(c, ctx)
        .select()
        .from(swarmTaskEvents)
        .where(eq(swarmTaskEvents.taskId, task.id))
        .orderBy(desc(swarmTaskEvents.at))
        .limit(TASK_EVENTS_SHOWN);
      events.reverse();

      const commits = await taskCommits(ctx, c, swarm, task);
      return c.json({ task, events, commits });
    })
    /**
     * Marks a leaf done, because a person says so.
     *
     * The tree is an agent's to fill in and a person's to correct. A
     * leaf a worker cannot finish, or one somebody finished by hand in
     * their own checkout, is still done, and a board that cannot be
     * told so is a board that drifts from the repository it describes.
     *
     * Only a leaf. A plan node is finished by its own children
     * finishing, and letting a person close one directly would leave
     * its subtree open underneath a node that says it is complete,
     * which is the one shape the rollup cannot render honestly.
     *
     * The runs go with it, the way cancelling a swarm takes its runs:
     * an agent still working a task the board calls done is spending
     * money on work nobody is waiting for, and its report would land
     * on a finished node. Marking done is the decision; the agent
     * stopping is that decision reaching the sandbox.
     */
    .post("/:id/tasks/:taskId/done", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      // Scoped to this swarm rather than looked up by id alone, so a
      // task id from another team's swarm reads as not there rather
      // than as a task this caller may not touch.
      const [task] = await db(c, ctx)
        .select()
        .from(swarmTasks)
        .where(and(eq(swarmTasks.id, c.req.param("taskId")), eq(swarmTasks.swarmId, swarm.id)))
        .limit(1);
      if (!task) return c.json({ error: "not found" }, 404);

      if (task.nodeType !== "leaf") {
        return c.json(
          { error: "A plan node is finished by its own tasks finishing.", code: "NOT_A_LEAF" },
          409,
        );
      }
      if (swarm.status === "cancelled") {
        return c.json(
          { error: "This swarm is stopped, so its tasks are not moving.", code: "SWARM_STOPPED" },
          409,
        );
      }
      // Already done is the answer the caller wanted, so it is not an
      // error: a second click, or two people in the same drawer, both
      // get the finished row rather than a refusal for something that
      // did happen.
      if (task.status === "done") return c.json(task);

      const now = new Date();
      const [done] = await db(c, ctx)
        .update(swarmTasks)
        .set({
          status: "done",
          // Nothing is waiting on a finished node, and an attention
          // flag left behind would keep it lit on a board whose whole
          // job is saying where to look.
          attention: null,
          assignedRunId: null,
          endedAt: now,
          updatedAt: now,
        })
        .where(eq(swarmTasks.id, task.id))
        .returning();

      /*
       * Then the agents, through the card board's cancellation, for
       * the reasons /cancel states: markCancelled is a compare-and-set
       * against the active statuses, it revokes the run's gateway
       * token, and a run this process is not carrying is marked rather
       * than interrupted.
       */
      const active = await db(c, ctx)
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmTaskId, task.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)));
      for (const run of active) {
        ctx.running.get(run.id)?.abort();
        await markCancelled(ctx, run.id);
      }

      // The rollup is the reconciler's, not this route's: one place
      // decides what a finished leaf means for the nodes above it.
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      return c.json(done);
    })
    /**
     * The node controls: retry, cancel, split, reassign, and editing
     * the description before any of them.
     *
     * All five under the swarm rather than on a route of their own, for
     * the reason the drawer's other routes are: a task id is only
     * meaningful inside its swarm, and resolving the swarm first is
     * what makes a task id from another team's swarm read as not there
     * rather than as a row this caller may not touch.
     *
     * What they change, they change through the same functions the
     * planner's tools use. A person and a planner editing one tree with
     * two different ideas of what cancelling means is exactly how the
     * two drift apart.
     */
    .post("/:id/tasks/:taskId/retry", async (c) => {
      const found = await accessibleTask(ctx, c);
      if ("refusal" in found) return found.refusal;
      const { swarm, task } = found;

      /*
       * Whether this may be retried at all is asked before anything is
       * touched, the way split asks it. A refusal that has already
       * killed an agent is a route that destroyed a branch and then
       * told the caller nothing had changed: the planner's own cancel
       * lets a worker finish its turn, so a cancelled leaf can still
       * have an agent on it, and that leaf is exactly the one somebody
       * reaches for Retry on.
       */
      const refusedFor = retryRefusal(task);
      if (refusedFor) return c.json({ error: refusedFor, code: "NOT_A_LEAF" }, 409);

      /*
       * Then the agent on it stops, and then the leaf goes back in the
       * queue. That order and not the other: the other starts a second
       * agent on a branch the first one is still committing to, which
       * is the one thing the merge queue cannot sort out afterwards.
       */
      await stopRunsOnTask(ctx, c, task.id);
      const retried = await retryLeaf(db(c, ctx), { task, actorUserId: actor(c) });
      if ("refused" in retried) return c.json({ error: retried.refused, code: "NOT_A_LEAF" }, 409);
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      return c.json(retried);
    })
    /**
     * Cancels a node, and everything under it.
     *
     * Its agent stops rather than being left to finish: a person
     * cancelling a task is not asking to keep paying for the turn in
     * flight. The planner's own cancel_task deliberately lets the run
     * end on its own, because a planner cancels to change the plan and
     * a person cancels to stop something.
     */
    .post("/:id/tasks/:taskId/cancel", async (c) => {
      const found = await accessibleTask(ctx, c);
      if ("refusal" in found) return found.refusal;
      const { swarm, task } = found;

      const cancelled = await cancelTaskTree(db(c, ctx), { task, actorUserId: actor(c) });
      for (const id of cancelled) await stopRunsOnTask(ctx, c, id);
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      return c.json({ cancelled });
    })
    /**
     * Splits a leaf into the tasks it should have been.
     *
     * The planner is not asked first, and is told afterwards by the
     * tree changing under it: a person who has read the diff usually
     * knows before the planner does that a leaf was too big.
     */
    .post(
      "/:id/tasks/:taskId/split",
      zValidator(
        "json",
        z.object({
          children: z
            .array(
              z.object({
                title: z.string().trim().min(1).max(200),
                description: z.string().max(20_000).optional(),
                weight: z.number().int().min(1).max(5).optional(),
              }),
            )
            .min(1)
            .max(20),
        }),
      ),
      async (c) => {
        const found = await accessibleTask(ctx, c);
        if ("refusal" in found) return found.refusal;
        const { swarm, task } = found;

        const created = await splitLeaf(db(c, ctx), {
          task,
          children: c.req.valid("json").children,
          actorUserId: actor(c),
        });
        if ("refused" in created) return c.json({ error: created.refused, code: "CANNOT_SPLIT" }, 409);
        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        return c.json({ created }, 201);
      },
    )
    /**
     * Puts a different agent on one leaf.
     *
     * On the leaf rather than on the template, because the answer to
     * one task a cheap worker could not finish is a stronger agent on
     * that task, not a stronger agent on every task that has not
     * started yet. Null puts it back on the template's own worker.
     *
     * The agent has to be one this caller can reach, which is the same
     * check every other route that names an agent makes: an id from
     * another team's agent list would otherwise become the agent a
     * swarm runs, with that team's credentials behind it.
     */
    .post(
      "/:id/tasks/:taskId/reassign",
      zValidator("json", z.object({ agentProfileId: z.string().uuid().nullable() })),
      async (c) => {
        const found = await accessibleTask(ctx, c);
        if ("refusal" in found) return found.refusal;
        const { swarm, task } = found;
        const { agentProfileId } = c.req.valid("json");

        if (agentProfileId) {
          const [profile] = await db(c, ctx)
            .select({ id: agentProfiles.id })
            .from(agentProfiles)
            .where(eq(agentProfiles.id, agentProfileId))
            .limit(1);
          if (!profile) return c.json({ error: "not found" }, 404);
        }

        const reassigned = await reassignLeaf(db(c, ctx), { task, agentProfileId, actorUserId: actor(c) });
        if ("refused" in reassigned) return c.json({ error: reassigned.refused, code: "NOT_A_LEAF" }, 409);
        // No tick: reassigning does not start anything. A leaf waiting
        // its turn keeps its place, and a retry is what pushes it.
        return c.json(reassigned);
      },
    )
    /**
     * Edits what a task says, which is what makes retrying it worth
     * anything.
     *
     * A leaf that failed because its description was wrong will fail
     * again against the same description. This is the half of "edit
     * before retry" that is not the retry: the two are separate calls
     * so a person can correct a task without restarting it, which is
     * the ordinary case while a plan is still being read.
     *
     * Not the status, and not the cost. Where a task is in its life is
     * decided by the routes above and by the reconciler, and a status
     * accepted here would walk past every one of their rules.
     */
    .patch(
      "/:id/tasks/:taskId",
      zValidator(
        "json",
        z
          .object({
            title: z.string().trim().min(1).max(200).optional(),
            description: z.string().max(20_000).optional(),
            weight: z.number().int().min(1).max(5).optional(),
          })
          .strict()
          .refine((value) => Object.keys(value).length > 0, { message: "nothing to change" }),
      ),
      async (c) => {
        const found = await accessibleTask(ctx, c);
        if ("refusal" in found) return found.refusal;
        const { swarm, task } = found;
        const body = c.req.valid("json");

        const [updated] = await db(c, ctx)
          .update(swarmTasks)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(swarmTasks.id, task.id))
          .returning();
        await db(c, ctx).insert(swarmTaskEvents).values({
          taskId: task.id,
          kind: "note",
          actorUserId: actor(c),
          detail: { edited: Object.keys(body) },
        });
        // The tree changed, so the board should say so. Nothing here
        // starts work: the rollup is the reconciler's either way.
        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        return c.json(updated);
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
 * The swarm, the node, and the three refusals the node routes share.
 *
 * Written once because it is the part that must never be forgotten:
 * the swarm is resolved first, the plan gate is asked about that
 * swarm's own organization, and the task is looked up scoped to the
 * swarm rather than by id alone. A task id from another team's swarm
 * then reads as not there, which is the convention every route in this
 * file follows.
 */
async function accessibleTask(
  ctx: AppContext,
  c: Context,
): Promise<
  | { swarm: typeof swarms.$inferSelect; task: typeof swarmTasks.$inferSelect }
  | { refusal: Response }
> {
  const swarmId = c.req.param("id") ?? "";
  const taskId = c.req.param("taskId") ?? "";
  const swarm = await getAccessibleSwarm(ctx, c, swarmId);
  if (!swarm) return { refusal: c.json({ error: "not found" }, 404) };
  const gate = await requireSwarms(ctx, c, swarm.organizationId);
  if (gate) return { refusal: c.json(gate.body, gate.status) };

  const [task] = await db(c, ctx)
    .select()
    .from(swarmTasks)
    .where(and(eq(swarmTasks.id, taskId), eq(swarmTasks.swarmId, swarm.id)))
    .limit(1);
  if (!task) return { refusal: c.json({ error: "not found" }, 404) };
  return { swarm, task };
}

/**
 * Stops whatever agent is on one node.
 *
 * Through the card board's own cancellation rather than a second one:
 * markCancelled is a compare and set against the active statuses, so a
 * run some other path already ended is not ended twice, and it is what
 * revokes the run's gateway token, meters the hours, and tells the
 * streams. A run this process is not carrying is marked rather than
 * interrupted; its token is dead from here either way, so its tools
 * stop answering.
 */
async function stopRunsOnTask(ctx: AppContext, c: Context, taskId: string): Promise<void> {
  const active = await db(c, ctx)
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.swarmTaskId, taskId), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)));
  for (const run of active) {
    ctx.running.get(run.id)?.abort();
    await markCancelled(ctx, run.id);
  }
}

/**
 * What one node's worker committed, read out of git.
 *
 * Through the `Bento-Task` trailer rather than from a column, which is
 * the whole reason the trailer exists: landing a worker's branch
 * rebases its commits onto the swarm's branch, every sha changes, and
 * a list of shas recorded when the work was done would name commits
 * that are no longer in any branch. The trailer survives the rebase,
 * so the same question can be asked of whichever branch the work is on
 * now.
 *
 * Which branch that is depends on where the node got to. Before it
 * lands, its commits are only on its own branch; after, they are on
 * the swarm's and its own branch may have been deleted. The swarm's
 * branch is asked first because that is where landed work is, and the
 * node's own branch answers for work that has not landed yet.
 *
 * A deployment whose driver keeps the repository inside the machine
 * has no checkout here to read, and `commitsForTask` answers an
 * unreadable repository with nothing rather than an error: the drawer
 * then says no commits, which is the truthful answer for a console
 * that cannot see them.
 */
async function taskCommits(
  ctx: AppContext,
  c: Parameters<typeof actor>[0],
  swarm: typeof swarms.$inferSelect,
  task: typeof swarmTasks.$inferSelect,
): Promise<{ repository: string; sha: string; subject: string; at: string }[]> {
  const repoRows = await db(c, ctx)
    .select({ name: repositories.name, localPath: repositories.localPath })
    .from(repositories)
    .where(eq(repositories.projectId, swarm.projectId))
    .orderBy(asc(repositories.position));

  const swarmBranch = swarm.branchName ?? swarmBranchName(swarm.slug);
  const own = task.branchName ?? workerBranchName(swarmBranch, task.id);
  const found: { repository: string; sha: string; subject: string; at: string }[] = [];
  for (const repo of repoRows) {
    const landed = await commitsForTask(repo.localPath, swarmBranch, task.id);
    const onBranch = landed.length > 0 ? landed : await commitsForTask(repo.localPath, own, task.id);
    found.push(...onBranch.map((commit) => ({ repository: repo.name, ...commit })));
  }
  return found;
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
      /**
       * Two at once on a local install, four on a hosted one.
       *
       * A hosted worker is its own machine, so four of them cost four
       * machines and nothing of the person's laptop. A local worker is
       * a worktree and a container on the machine somebody is also
       * using: four agents each running the repository's test command
       * is four builds competing for the same cores, and the install
       * that is meant to be watched becomes the one nobody can type on.
       *
       * Written onto the template rather than read from the mode at
       * spawn time, so an install that later joins a team keeps the
       * shape its swarms already had, and so a person who wants four
       * can simply set four. A number nobody can see and nobody can
       * change is not a default, it is a rule.
       */
      maxWorkers: ctx.env.BENTO_MODE === "multi" ? 4 : 2,
      /**
       * And where those workers work, written down for the same
       * reason the number is.
       *
       * A local install's agents share the repository it already has
       * on disk, each in a worktree of its own; a hosted one gives
       * each agent a machine holding its own clone. Recorded rather
       * than read off the driver every time, so an install that later
       * joins a team is told its swarms cannot keep their shape
       * instead of quietly being given another one.
       */
      workerIsolation: ctx.env.BENTO_MODE === "multi" ? "sandbox" : "worktree",
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
