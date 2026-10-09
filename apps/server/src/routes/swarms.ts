import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { SandboxHandle } from "@bento/sandbox";
import {
  agentProfiles,
  agentRuns,
  ensureSwarmAgents,
  projects,
  repositories,
  runArtifacts,
  runEvents,
  sandboxes,
  swarmLandings,
  swarmMessages,
  swarmPlanSources,
  swarmPullRequests,
  swarmTaskEvents,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import {
  canAccessProject,
  getAccessibleSwarm,
  getActiveOrganizationMembership,
  visibleProjectFilter,
} from "../access.js";
import type { AppContext } from "../context.js";
import type { BoardEvent } from "../events.js";
import { runsForCaller } from "../feature-flags.js";
import { actor } from "../middleware/actor.js";
import { deferAfterCommit, deferOnRollback, tenantDb as db } from "../middleware/tenant.js";
import { queueSwarmSandboxReap, reapSwarmSandbox } from "../orchestrator/reap-sandbox.js";
import { enqueueTaskStartOver } from "../orchestrator/swarm/start-over.js";
import { enqueueSwarmPublish } from "../orchestrator/swarm/complete.js";
import { driverForProject, driverForSandbox } from "../orchestrator/sandbox-driver.js";
import { markCancelled } from "../orchestrator/run-executor.js";
import { enqueueSwarmTick } from "../orchestrator/swarm/coordinator.js";
import { MAX_PLAN_DEPTH, MAX_SWARM_GOAL_CHARS, MAX_SWARM_WORKERS } from "@bento/core";
import { requireSwarms } from "../orchestrator/swarm/gate.js";
import { swarmBranchName } from "../orchestrator/swarm/sandbox.js";
import { branchCheckoutPath, releaseSwarmBranch } from "../orchestrator/swarm/release-branch.js";
import { isSafeBranchName, workerBranchName } from "../orchestrator/swarm/branches.js";
import { commitsForTask } from "../orchestrator/swarm/landing-git.js";
import {
  addLeaf,
  addedTaskNotice,
  cancelTaskTree,
  descendantIds,
  landingRetryRefusal,
  reassignLeaf,
  reactivateSwarmForRetry,
  requeuedLanding,
  retryLeaf,
  retryRefusal,
  withdrawTaskLandings,
  splitLeaf,
} from "../orchestrator/swarm/task-actions.js";
import { quoteUntrusted } from "../orchestrator/swarm/planner-prompt.js";
import {
  collectPlanSources,
  insertPlanSources,
  listPlanSources,
  PlanSourceRefusal,
  planSourceStorageKeys,
  planSourcesInput,
} from "../orchestrator/swarm/plan-sources.js";
import { archiveReapsSandboxes, checkpointSwarmSandboxes } from "../orchestrator/swarm/archive.js";
import { reopenRefusal, reopenSwarm, swarmHasActiveRun } from "../orchestrator/swarm/reopen.js";
import { captureSwarmSpend } from "../orchestrator/swarm/spend.js";
import { budgetRefusal } from "../orchestrator/swarm/ledger.js";
import { recordSwarmAnswer } from "../orchestrator/swarm/messages.js";
import { queueSwarmSlackNotify } from "../orchestrator/slack-notify.js";
import { ACTIVE_RUN_STATUSES, NO_REPOSITORIES, projectHasRepositories, SWARM_FULL, startRunIfIdle } from "../orchestrator/start-run.js";
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

/** What a request that would pull a branch out from under a landing in flight is told. */
const LANDING_IN_FLIGHT = "This task's branch is landing right now. Try again when the merge queue finishes with it.";

/** A restart can overwrite a failure the agent already recorded. Show the agent's reason. */
async function plannerFailureText(ctx: AppContext, c: Context, run: { id: string; error: string | null }) {
  const results = await db(c, ctx)
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "result")))
    .orderBy(desc(runEvents.seq))
    .limit(20);
  const agentError = results
    .map(({ payload }) => {
      const value = (payload as { error?: unknown }).error;
      return typeof value === "string" ? value.trim() : "";
    })
    .find((error) => error !== "" && !/server restart|Bento restarted/i.test(error));
  return agentError ?? run.error;
}

/**
 * How much of one node's history the drawer is sent.
 *
 * A node that was assigned, reported, rejected and reassigned six
 * times has an event per step, and the drawer is something a person
 * reads rather than a log they page through. The newest are the ones
 * that explain where the node is now.
 */
const TASK_EVENTS_SHOWN = 50;

/**
 * How many of a swarm's artifacts the console is sent.
 *
 * A swarm of fifty leaves can capture a file per leaf, and the list is
 * a panel a person glances at rather than a directory they page
 * through. Newest first, so the assembled document (written last, at
 * the moment the swarm finished) is at the top.
 */
const SWARM_ARTIFACTS_SHOWN = 50;

/**
 * A piece of free text a person may leave empty. Trimmed, and empty
 * stored as null, so "no instructions" and "   " are the same row and
 * a prompt is never handed a heading with nothing under it.
 */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim() || null)
    .nullable();

/**
 * How the swarm is run, beyond its agents and ceilings. Every one is
 * optional and defaults to what a swarm does when nobody says: no
 * judge, no completion command, one planner, no extra instructions.
 */
const swarmSettings = {
  judgeProfileId: z.string().uuid().nullable().optional(),
  completionCommand: optionalText(4000).optional(),
  maxPlanDepth: z.number().int().min(1).max(MAX_PLAN_DEPTH).optional(),
  plannerInstructions: optionalText(20_000).optional(),
  workerInstructions: optionalText(20_000).optional(),
};

const createSwarm = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  goal: z.string().max(MAX_SWARM_GOAL_CHARS).default(""),
  plannerProfileId: z.string().uuid().optional(),
  workerProfileId: z.string().uuid().optional(),
  maxWorkers: z.number().int().min(1).max(MAX_SWARM_WORKERS).optional(),
  budgetUsd: z.number().min(0).max(100_000).nullish(),
  timeLimitMin: z.number().int().min(1).max(60 * 24 * 7).nullish(),
  /** A change to the code, or a document. Fixed once the swarm exists. */
  deliverable: z.enum(["code", "document"]).default("code"),
  ...swarmSettings,
  /**
   * A branch that already exists, to start from.
   *
   * The swarm's own branch is cut from this rather than from the
   * repository's default branch, and the planner's first prompt
   * carries what is on it and what its pull request is still being
   * asked about. Refused here rather than sanitized: the value reaches
   * git, and a name with a space, a colon or a leading dash in it is
   * either a mistake or an argument.
   */
  startBranch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => isSafeBranchName(value), "that is not a branch name")
    .nullish(),
  /**
   * Where the plan comes from, and the plan itself.
   *
   * "goal" is the ordinary swarm: the planner reads the goal and the
   * code and writes the plan. "existing" says the person already has
   * one, in the sources below or in the goal text, and the planner
   * turns it into the task tree rather than planning from scratch.
   * Sources without the mode are reference material; the mode
   * without sources means the goal text is the plan.
   */
  planMode: z.enum(["goal", "existing"]).default("goal"),
  planSources: planSourcesInput.optional(),
});

/**
 * How large a create request may be.
 *
 * A plan arrives inline: text as text, PDFs and images as base64,
 * which is a third larger than the bytes. The caps are on the sources
 * themselves (MAX_SWARM_PLAN_CHARS of text, MAX_SWARM_PLAN_BYTES of
 * bytes across every source), so this only has to be generous against
 * the sum of both with JSON escaping on top, and still far below
 * anything an uploaded plan has a reason to be.
 */
const CREATE_BODY_BYTES = 48 * 1024 * 1024;

/** The media types the plan source content route lets a browser draw inline. Everything else downloads. */
const PLAN_SOURCE_INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown"]);

/** A source's own name, defanged for a header it travels inside. */
function headerSafeName(name: string): string {
  const base = name.split("/").pop() ?? "source";
  const safe = base.replaceAll(/[^\w.-]/g, "_");
  return safe || "source";
}

/**
 * What a person may change about a swarm: what it is called, its
 * ceilings, how it is run, and whether it is put away.
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
    maxWorkers: z.number().int().min(1).max(MAX_SWARM_WORKERS).optional(),
    budgetUsd: z.number().min(0).max(100_000).nullable().optional(),
    timeLimitMin: z.number().int().min(1).max(60 * 24 * 7).nullable().optional(),
    /**
     * The agents, which a person changes when one was deleted or was
     * not up to the work. Not nullable: a swarm with no planner has
     * nobody to plan with, so clearing one is not a setting.
     */
    plannerProfileId: z.string().uuid().optional(),
    workerProfileId: z.string().uuid().optional(),
    ...swarmSettings,
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "nothing to change" });


/**
 * Says the swarm changed, once the change is committed.
 *
 * Every route below that moves a swarm calls this, and the reason is
 * the one thing a board event is for: somebody who is not the person
 * who pressed the button. The console refetches after its own action
 * and so looked correct while it was the only viewer; a second tab, a
 * terminal running `bento swarm watch`, and a teammate watching the
 * same swarm heard nothing at all until the next tick happened to fire
 * for some other reason. Stopping a swarm from one window left it
 * running on every other screen.
 *
 * After the commit, never inside it, for the reason the coordinator
 * emits after its transaction: a viewer that refetches on the event
 * has to find the state the event describes.
 */
function saySwarmChanged(
  ctx: AppContext,
  c: Context,
  swarm: Pick<typeof swarms.$inferSelect, "id" | "projectId">,
  status?: string,
): void {
  deferAfterCommit(c, async () => {
    ctx.bus.emitBoardEvent({
      type: "swarm_updated",
      projectId: swarm.projectId,
      swarmId: swarm.id,
      ...(status ? { status } : {}),
    });
  });
}

/** Releases saved work when a person starts or resumes a swarm. */
async function releaseOpenSwarmLeaves(
  ctx: AppContext,
  c: Context,
  swarm: Pick<typeof swarms.$inferSelect, "id" | "projectId">,
): Promise<void> {
  const released = await db(c, ctx)
    .update(swarmTasks)
    .set({ status: "assigned", updatedAt: new Date() })
    .where(and(eq(swarmTasks.swarmId, swarm.id), eq(swarmTasks.nodeType, "leaf"), eq(swarmTasks.status, "open"), isNull(swarmTasks.attention)))
    .returning({ id: swarmTasks.id });
  if (released.length === 0) return;
  await db(c, ctx).insert(swarmTaskEvents).values(released.map(({ id }) => ({
    taskId: id,
    kind: "status_changed" as const,
    fromStatus: "open",
    toStatus: "assigned",
    actorUserId: actor(c),
  })));
  for (const task of released) {
    deferAfterCommit(c, async () => {
      ctx.bus.emitBoardEvent({
        type: "swarm_task_updated",
        projectId: swarm.projectId,
        swarmId: swarm.id,
        taskId: task.id,
        status: "assigned",
      });
    });
  }
}

/** An empty plan group has no work that a dependent child can wait for. */
async function repairEmptyPlanDependencies(
  ctx: AppContext,
  c: Context,
  swarm: Pick<typeof swarms.$inferSelect, "id" | "projectId">,
): Promise<void> {
  const tasks = await db(c, ctx)
    .select({
      id: swarmTasks.id,
      parentId: swarmTasks.parentId,
      parentRelation: swarmTasks.parentRelation,
      nodeType: swarmTasks.nodeType,
      status: swarmTasks.status,
      assignedRunId: swarmTasks.assignedRunId,
    })
    .from(swarmTasks)
    .where(eq(swarmTasks.swarmId, swarm.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const groupsWithWork = new Set(tasks
    .filter((task) => task.parentId && task.parentRelation === "contains" && task.status !== "cancelled")
    .map((task) => task.parentId!));
  const stranded = tasks.filter((task) => {
    if (!task.parentId || task.parentRelation !== "depends_on" || task.status === "cancelled") return false;
    const parent = byId.get(task.parentId);
    return parent?.nodeType === "plan" && parent.status === "open" && !parent.assignedRunId &&
      !groupsWithWork.has(parent.id);
  });
  if (stranded.length === 0) return;

  await db(c, ctx)
    .update(swarmTasks)
    .set({ parentRelation: "contains", updatedAt: new Date() })
    .where(inArray(swarmTasks.id, stranded.map((task) => task.id)));
  await db(c, ctx).insert(swarmTaskEvents).values(stranded.map((task) => ({
    taskId: task.id,
    kind: "note" as const,
    actorUserId: actor(c),
    detail: { reason: "An empty plan group cannot be a prerequisite. This task is now part of that group." },
  })));
  for (const task of stranded) {
    deferAfterCommit(c, async () => {
      ctx.bus.emitBoardEvent({
        type: "swarm_task_updated",
        projectId: swarm.projectId,
        swarmId: swarm.id,
        taskId: task.id,
        status: task.status,
      });
    });
  }
}

/**
 * Workers a swarm starts with when the person creating it did not say.
 *
 * Two on a local install, four on a hosted one. A hosted worker is its
 * own machine, so four of them cost four machines and nothing of the
 * person's laptop. A local worker is a worktree and a container on the
 * machine somebody is also using: four agents each running the
 * repository's test command is four builds competing for the same
 * cores. A starting value and not a limit; MAX_SWARM_WORKERS is that.
 */
export function defaultMaxWorkers(ctx: AppContext): number {
  return ctx.env.BENTO_MODE === "multi" ? 4 : 2;
}

/**
 * Where a new swarm's workers work.
 *
 * Worktrees of the checkout on the server wherever the driver can
 * provide them, which is a local install on its own machine; a machine
 * per agent otherwise. Read off the driver as well as the mode, because
 * a local install can run its agents on sprites, and a sprite holds its
 * own clone: asking for worktrees there would be refused at the first
 * run, with nothing a person could change to get past it.
 */
export function defaultWorkerIsolation(mode: "local" | "multi", workspace: "host" | "clone"): "sandbox" | "worktree" {
  return mode === "multi" || workspace === "clone" ? "sandbox" : "worktree";
}

/** Whether this swarm's checkouts live inside the sandbox rather than on the server. */
async function swarmCloneWorkspace(
  ctx: AppContext,
  c: Context,
  swarm: { sandboxId: string | null; projectId: string },
): Promise<boolean> {
  if (swarm.sandboxId) {
    const [row] = await db(c, ctx)
      .select({ provider: sandboxes.provider, status: sandboxes.status })
      .from(sandboxes)
      .where(eq(sandboxes.id, swarm.sandboxId))
      .limit(1);
    if (row && row.status !== "destroyed") return driverForSandbox(ctx.drivers, row).workspace === "clone";
  }
  // No machine yet. A project set to a clone driver (Sprite or Modal)
  // still lands inside the sandbox. A project left on the default
  // keeps that driver's workspace, which is the host on Docker and
  // local-process.
  const [project] = await db(c, ctx)
    .select({ sandboxProvider: projects.sandboxProvider, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, swarm.projectId))
    .limit(1);
  if (!project) return ctx.drivers.default.workspace === "clone";
  return (await driverForProject(ctx, project, actor(c))).workspace === "clone";
}

/**
 * Whether this agent is one a swarm in this organization may run.
 *
 * The agent has to belong to the swarm's team, or on a local install
 * to the caller, the same rule the agent routes apply. Answered as a
 * yes or no so every caller can refuse with the same 404: an agent id
 * from another team reads as not there.
 */
async function canUseProfile(
  ctx: AppContext,
  c: Context,
  organizationId: string | null,
  profileId: string,
): Promise<boolean> {
  const [profile] = await db(c, ctx)
    .select({ ownerId: agentProfiles.ownerId, organizationId: agentProfiles.organizationId })
    .from(agentProfiles)
    .where(eq(agentProfiles.id, profileId))
    .limit(1);
  if (!profile) return false;
  return organizationId
    ? profile.organizationId === organizationId
    : profile.organizationId === null && profile.ownerId === actor(c);
}

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
    .post("/", bodyLimit({ maxSize: CREATE_BODY_BYTES }), zValidator("json", createSwarm), async (c) => {
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
      if (!(await projectHasRepositories(db(c, ctx), project.id))) {
        return c.json({ error: NO_REPOSITORIES }, 409);
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
      if (ctx.env.BENTO_MODE === "multi" && project.organizationId && !membership) {
        return c.json({ error: "not found" }, 404);
      }
      for (const profileId of [body.plannerProfileId, body.workerProfileId, body.judgeProfileId]) {
        if (profileId && !(await canUseProfile(ctx, c, project.organizationId, profileId))) {
          return c.json({ error: "agent not found" }, 404);
        }
      }
      /*
       * The agents a person did not choose are the install's own
       * Swarm Planner and Swarm Worker, made the first time anybody
       * needs them. Asked only when one is missing, so a swarm with
       * both chosen writes nothing it did not ask for.
       */
      const defaults =
        body.plannerProfileId && body.workerProfileId
          ? null
          : await ensureSwarmAgents(db(c, ctx), {
              ownerId: actor(c),
              organizationId: ctx.env.BENTO_MODE === "multi" ? project.organizationId : null,
            });
      const plannerProfileId = body.plannerProfileId ?? defaults?.planner ?? null;
      const workerProfileId = body.workerProfileId ?? defaults?.worker ?? null;
      if (!plannerProfileId) {
        return c.json({ error: "Choose a planner agent for this swarm." }, 400);
      }

      const budgetUsd = body.budgetUsd === undefined || body.budgetUsd === null ? null : String(body.budgetUsd);
      const budget = budgetRefusal({
        budgetUsd,
        spentMeasuredUsd: "0",
        spentEstimatedUsd: "0",
        spentAssumedUsd: "0",
        spentNotionalUsd: "0",
      });
      if (budget) return c.json({ error: budget, code: "PLAN_LIMIT" }, 402);

      /*
       * The plan the person handed over, resolved before anything is
       * written: every website in it is fetched now, by the server,
       * and a page that cannot be read refuses the whole request
       * rather than leaving a swarm with half its plan.
       */
      let planSources;
      try {
        planSources = await collectPlanSources(ctx.env, body.planSources ?? [], { hasStore: ctx.artifacts !== null });
      } catch (err) {
        if (err instanceof PlanSourceRefusal) return c.json({ error: err.message, code: "PLAN_SOURCE" }, 400);
        throw err;
      }

      const slug = await uniqueSlug(ctx, c, project.id, body.title);
      const [swarm] = await db(c, ctx)
        .insert(swarms)
        .values({
          projectId: project.id,
          slug,
          title: body.title,
          goal: body.goal,
          plannerProfileId,
          workerProfileId,
          /*
           * Where the workers work, written down now rather than read
           * off the deployment on every run: a local install's agents
           * share the checkout on disk, each in a worktree; a hosted
           * one gives each agent a machine holding its own clone. An
           * install that later joins a team is then told its swarms
           * cannot keep their shape, instead of quietly given another.
           */
          workerIsolation: defaultWorkerIsolation(
            ctx.env.BENTO_MODE === "multi" ? "multi" : "local",
            (await driverForProject(ctx, project, actor(c))).workspace,
          ),
          judgeProfileId: body.judgeProfileId ?? null,
          completionCommand: body.completionCommand ?? null,
          maxPlanDepth: body.maxPlanDepth ?? 1,
          plannerInstructions: body.plannerInstructions ?? null,
          workerInstructions: body.workerInstructions ?? null,
          // Planning, not draft: the planner starts below, and a person
          // watching should see that rather than a swarm that looks
          // like it is waiting for them.
          status: "planning",
          branchName: swarmBranchName(slug),
          deliverable: body.deliverable,
          startBranch: body.startBranch ?? null,
          planMode: body.planMode,
          maxWorkers: body.maxWorkers ?? defaultMaxWorkers(ctx),
          budgetUsd,
          timeLimitMin: body.timeLimitMin ?? null,
          startedBy: actor(c),
        })
        .returning();
      if (!swarm) return c.json({ error: "something went wrong starting the swarm; try again" }, 500);
      /*
       * The bytes go on the shelf now, inside the request. If anything
       * after this throws, the rows roll back with the request and the
       * objects would stay with nothing pointing at them; the removal
       * registered here runs on exactly that path. Not a refusal to
       * answer with 400: collectPlanSources already refused bytes with
       * nowhere to go, so a throw here is a bug, and answering it
       * politely would commit a swarm with no sources and no planner.
       */
      const shelved = await insertPlanSources(db(c, ctx), ctx.artifacts, { id: swarm.id, organizationId: swarm.organizationId }, planSources);
      if (shelved.length > 0 && ctx.artifacts) {
        const store = ctx.artifacts;
        deferOnRollback(c, async () => {
          await store.remove(shelved);
        });
      }

      const run = await startRunIfIdle(
        db(c, ctx),
        {
          type: "swarm" as const,
          swarmId: swarm.id,
          role: "planner",
          agentProfileId: plannerProfileId,
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
      deferAfterCommit(c, () => queueSwarmSlackNotify(ctx, { type: "swarm_created", swarmId: swarm.id, userId: actor(c) }));
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
          startedAt: agentRuns.startedAt,
          agentStartedAt: agentRuns.agentStartedAt,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .orderBy(desc(agentRuns.queuedAt));
      const [{ agentTimeMs = 0 } = { agentTimeMs: 0 }] = await db(c, ctx)
        .select({ agentTimeMs: sql<number>`coalesce(sum(case
          when ${agentRuns.startedAt} is not null
            and (${agentRuns.endedAt} is not null or ${agentRuns.status} = 'running')
            and ${agentRuns.billable} = true
            and (${agentRuns.error} is null or ${agentRuns.error} not like 'sandbox provisioning failed:%')
          then greatest(0, extract(epoch from (coalesce(${agentRuns.endedAt}, now()) - ${agentRuns.startedAt})) * 1000)
          else 0 end), 0)::double precision` })
        .from(agentRuns)
        .where(eq(agentRuns.swarmId, swarm.id));
      const [plannerRun] = await db(c, ctx)
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          error: agentRuns.error,
          agentProfileId: agentRuns.agentProfileId,
          queuedAt: agentRuns.queuedAt,
          startedAt: agentRuns.startedAt,
          endedAt: agentRuns.endedAt,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner")))
        .orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id))
        .limit(1);
      const [plannerAgent] = plannerRun
        ? await db(c, ctx)
            .select({ name: agentProfiles.name, cli: agentProfiles.cli, model: agentProfiles.model })
            .from(agentProfiles)
            .where(eq(agentProfiles.id, plannerRun.agentProfileId))
            .limit(1)
        : [];
      const plannerError = plannerRun?.status === "failed" ? await plannerFailureText(ctx, c, plannerRun) : plannerRun?.error ?? null;
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
        errorCode: swarmLandings.errorCode,
        resolverRunId: swarmLandings.resolverRunId,
        // When a queued row may be tried again, so the panel can say a
        // branch is waiting out a backoff rather than waiting its turn.
        notBefore: swarmLandings.notBefore,
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
      const [landingSummary] = await db(c, ctx)
        .select({
          total: sql<number>`count(*)::integer`,
          committed: sql<number>`count(*) filter (where ${swarmLandings.status} = 'landed')::integer`,
        })
        .from(swarmLandings)
        .where(eq(swarmLandings.swarmId, swarm.id));
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
      /**
       * What the person handed the planner, without the text: the
       * list is for a page that says what the plan was built from,
       * and the text is the planner's to read through its tools.
       */
      const planSources = await listPlanSources(db(c, ctx), swarm.id);
      const retryable = await landingRetryableTasks(ctx, c, swarm, tasks);
      return c.json({
        swarm,
        tasks: tasks.map((task) => ({ ...task, canRetryLanding: retryable.has(task.id) })),
        planSources,
        activeRuns: runs,
        agentTimeMs,
        plannerRun: plannerRun ? { ...plannerRun, error: plannerError, agent: plannerAgent ?? null } : null,
        landings,
        landingSummary: landingSummary ?? { total: 0, committed: 0 },
        branchCheckout: {
          mode: (await swarmCloneWorkspace(ctx, c, swarm)) ? "remote" : "worktree",
          released: swarm.branchReleasedAt !== null,
        },
        pullRequests,
      });
    })
    .post("/:id/branch/release", async (c) => {
      const accessible = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!accessible) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, accessible.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      if (await swarmCloneWorkspace(ctx, c, accessible)) {
        return c.json({ error: "This deployment does not keep a local swarm worktree." }, 409);
      }
      const [swarm] = await db(c, ctx)
        .select()
        .from(swarms)
        .where(eq(swarms.id, accessible.id))
        .for("update");
      if (!swarm) return c.json({ error: "not found" }, 404);
      if (swarm.branchReleasedAt) return c.json({ released: true });
      if (swarm.status !== "done") {
        return c.json({ error: "Finish the swarm before releasing its branch." }, 409);
      }
      if (await swarmHasActiveRun(db(c, ctx), swarm.id)) {
        return c.json({ error: "An agent is still working. Wait for it to finish before releasing the branch." }, 409);
      }
      const [pending] = await db(c, ctx)
        .select({ count: sql<number>`count(*)::integer` })
        .from(swarmLandings)
        .where(and(eq(swarmLandings.swarmId, swarm.id), inArray(swarmLandings.status, ["queued", "landing", "conflicted"])));
      if (pending?.count) {
        return c.json({ error: "The merge queue still has branches to process." }, 409);
      }
      const repos = await db(c, ctx)
        .select({ name: repositories.name, localPath: repositories.localPath })
        .from(repositories)
        .where(eq(repositories.projectId, swarm.projectId));
      if (!swarm.branchName || repos.length === 0) {
        return c.json({ error: "This swarm has no local branch to release." }, 409);
      }
      try {
        // The finished swarm may still have an idle container mounting
        // this directory. Stop it before Git removes the checkout.
        await reapSwarmSandbox(ctx, swarm.id);
        await releaseSwarmBranch(ctx.worktrees, swarm.id, swarm.branchName, repos);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Could not release the branch." }, 409);
      }
      await db(c, ctx).update(swarms).set({ branchReleasedAt: new Date() }).where(eq(swarms.id, swarm.id));
      saySwarmChanged(ctx, c, swarm, "done");
      return c.json({ released: true });
    })
    .patch("/:id", zValidator("json", updateSwarm), async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      const body = c.req.valid("json");
      for (const profileId of [body.plannerProfileId, body.workerProfileId, body.judgeProfileId]) {
        if (profileId && !(await canUseProfile(ctx, c, swarm.organizationId, profileId))) {
          return c.json({ error: "agent not found" }, 404);
        }
      }

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
      /*
       * The run settings are read fresh on every tick, so a judge or a
       * completion command set on a swarm that is already waiting on
       * its last leaf is asked about on the next one rather than after
       * whatever happens to wake the swarm next. A new worker is the
       * same: leaves that were waiting for one can start now.
       */
      const ceilingMoved =
        rest.maxWorkers !== undefined ||
        budgetUsd !== undefined ||
        rest.timeLimitMin !== undefined ||
        rest.judgeProfileId !== undefined ||
        rest.plannerProfileId !== undefined ||
        rest.workerProfileId !== undefined ||
        rest.completionCommand !== undefined ||
        rest.maxPlanDepth !== undefined;
      if (budgetUsd !== undefined) {
        await db(c, ctx).update(swarms).set({ budgetWarnedAt: null }).where(eq(swarms.id, swarm.id));
      }
      if (ceilingMoved) deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      /*
       * A swarm somebody put away holds a machine nobody will work in
       * again, and a sprite costs money for as long as it exists
       * rather than for as long as it is used.
       *
       * Only when the swarm is actually finished with: archiving one
       * that is still running is a person tidying their strip, and
       * destroying a machine an agent is working in would leave a
       * branch nobody chose. Queued rather than destroyed inline, for
       * the reason a finished swarm's reap is queued, and safe to
       * queue twice because a machine already gone is no rows.
       */
      if (archived === true && archiveReapsSandboxes(swarm)) {
        deferAfterCommit(c, () => queueSwarmSandboxReap(ctx, swarm.id));
      }
      saySwarmChanged(ctx, c, swarm);
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
      /*
       * And the machines are put away with a point to come back to.
       *
       * After the commit and off the request, because the provider is
       * a network call away and pausing must not fail because Fly was
       * slow. A driver that cannot snapshot does nothing here, which
       * is right for the local ones: their containers hold nothing the
       * repository on this host does not already have.
       */
      deferAfterCommit(c, async () => {
        await checkpointSwarmSandboxes(ctx.db, ctx.drivers, swarm.id, `swarm-pause-${swarm.id}`);
      });
      saySwarmChanged(ctx, c, swarm, "paused");
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
      saySwarmChanged(ctx, c, swarm, "cancelled");
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
    /**
     * Opens the pull requests of a finished swarm, in the shape a
     * person chose: "combined", one pull request of the swarm's branch
     * with every task merged in order, or "stacked", one per landed task
     * against the task before it. The branches are already on GitHub
     * (pushed as the swarm went), so this only asks GitHub for the
     * pull requests, through the publish queue, which retries.
     */
    .post("/:id/publish", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      const body = await c.req.json().catch(() => ({}));
      const parsed = z.object({ mode: z.enum(["combined", "stacked"]) }).safeParse(body);
      if (!parsed.success) return c.json({ error: "Choose combined or stacked pull requests." }, 400);
      if (swarm.status !== "done") {
        return c.json({ error: "Pull requests open once the swarm is done." }, 409);
      }
      deferAfterCommit(c, () => enqueueSwarmPublish(ctx, swarm.id, parsed.data.mode));
      return c.json({ mode: parsed.data.mode, status: "queued" }, 202);
    })
    .post("/:id/planner/retry", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      if (swarm.status !== "planning") {
        return c.json({ error: "Only a swarm waiting for its first plan can retry the planner." }, 409);
      }
      const [latest] = await db(c, ctx)
        .select({ status: agentRuns.status, agentProfileId: agentRuns.agentProfileId })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner")))
        .orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id))
        .limit(1);
      if (latest?.status !== "failed") {
        return c.json({ error: "The planner has not failed, so there is nothing to retry." }, 409);
      }
      const [{ count } = { count: 0 }] = await db(c, ctx)
        .select({ count: sql<number>`count(*)::int` })
        .from(swarmTasks)
        .where(eq(swarmTasks.swarmId, swarm.id));
      if (count > 0) {
        return c.json({ error: "This swarm already has a plan. Start it or send the planner a message." }, 409);
      }
      if (!(await projectHasRepositories(db(c, ctx), swarm.projectId))) {
        return c.json({ error: NO_REPOSITORIES }, 409);
      }
      const plannerProfileId = swarm.plannerProfileId ?? latest.agentProfileId;
      const run = await startRunIfIdle(
        db(c, ctx),
        {
          type: "swarm",
          swarmId: swarm.id,
          role: "planner",
          agentProfileId: plannerProfileId,
          prompt: "",
          executor: "server",
          startedBy: actor(c),
        },
        ctx.entitlements,
        ctx.analytics,
        (task) => deferAfterCommit(c, async () => task()),
      );
      if (run === "gone") return c.json({ error: "not found" }, 404);
      if (run === "busy" || run === SWARM_FULL) {
        return c.json({ error: "The planner is already working. Wait for it to finish." }, 409);
      }
      if ("outOfCompute" in run) {
        return c.json({ error: run.outOfCompute, code: "PLAN_LIMIT" }, 402);
      }
      deferAfterCommit(c, () => enqueueRun(ctx, run.id));
      saySwarmChanged(ctx, c, swarm, "planning");
      return c.json({ runId: run.id }, 201);
    })
    .post("/:id/planner/stop", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      const [run] = await db(c, ctx)
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner"), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1);
      if (!run) return c.json({ error: "The planner is not running." }, 409);

      ctx.running.get(run.id)?.abort();
      await markCancelled(ctx, run.id);
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      saySwarmChanged(ctx, c, swarm);
      return c.json({ runId: run.id, status: "cancelled" });
    })
    .post("/:id/start", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      /*
       * A ceiling is lifted by raising it, not by starting. Starting one
       * put the swarm back to "running" until the next tick refused the
       * spawn and ended it again, so the button looked like it worked.
       * Raising the ceiling (PATCH /api/swarms/:id, the Settings dialog)
       * is what the coordinator acts on, and reopen raises it with a
       * follow up.
       */
      if (swarm.status === "budget_exhausted") {
        return c.json({
          error: "This swarm reached its budget. Raise the budget in Settings and it carries on, or add a follow up with a higher budget.",
          code: "BUDGET",
        }, 409);
      }
      if (swarm.status === "timed_out") {
        return c.json({
          error: "This swarm reached its time limit. Raise the time limit in Settings and it carries on, or add a follow up with a longer limit.",
          code: "TIME_LIMIT",
        }, 409);
      }

      const [{ count } = { count: 0 }] = await db(c, ctx)
        .select({ count: sql<number>`count(*)::int` })
        .from(swarmTasks)
        .where(and(eq(swarmTasks.swarmId, swarm.id), eq(swarmTasks.nodeType, "leaf"), sql`${swarmTasks.status} <> 'cancelled'`));
      if (count === 0) {
        const [latestPlanner] = await db(c, ctx)
          .select({ id: agentRuns.id, status: agentRuns.status, error: agentRuns.error })
          .from(agentRuns)
          .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner")))
          .orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id))
          .limit(1);
        if (latestPlanner?.status === "failed") {
          const error = await plannerFailureText(ctx, c, latestPlanner);
          return c.json({
            error: `The planner failed before it could make a plan. ${error ?? "Check the planner run for details."} Retry the planner.`,
            code: "PLANNER_FAILED",
          }, 409);
        }
        return c.json(
          { error: "This swarm has no plan yet, so there is nothing to start. Wait for the planner or check its output.", code: "NO_PLAN" },
          409,
        );
      }
      // Older coordinator versions could mark a swarm done while a
      // dependent leaf was still open. Let a person approve that saved
      // work through the normal start path instead of asking them to
      // create a duplicate follow up task.
      const [unfinishedLeaf] = swarm.status === "done"
        ? await db(c, ctx)
          .select({ id: swarmTasks.id })
          .from(swarmTasks)
          .where(and(
            eq(swarmTasks.swarmId, swarm.id),
            eq(swarmTasks.nodeType, "leaf"),
            eq(swarmTasks.status, "open"),
            isNull(swarmTasks.attention),
          ))
          .limit(1)
        : [];
      if (swarm.status === "cancelled" || (swarm.status === "done" && !unfinishedLeaf)) {
        return c.json({ error: `This swarm is ${swarm.status}, so it cannot be started.` }, 409);
      }
      if (swarm.status === "done" && swarm.branchReleasedAt && swarm.branchName && !(await swarmCloneWorkspace(ctx, c, swarm))) {
        const repos = await db(c, ctx)
          .select({ name: repositories.name, localPath: repositories.localPath })
          .from(repositories)
          .where(eq(repositories.projectId, swarm.projectId));
        for (const repo of repos) {
          const checkout = await branchCheckoutPath(repo.localPath, swarm.branchName);
          if (checkout) {
            return c.json({
              error: `Switch ${repo.name} to another branch before approving this work. ${swarm.branchName} is checked out at ${checkout}.`,
              code: "BRANCH_IN_USE",
            }, 409);
          }
        }
      }
      const [activePlanner] = await db(c, ctx)
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmId, swarm.id), eq(agentRuns.role, "planner"), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      if (activePlanner) {
        return c.json({ error: "The planner is still working. Wait for it to finish or stop it before approving the plan." }, 409);
      }

      // Start and Resume are an explicit decision to work the saved plan.
      // A planner can put the first task below an empty plan group as
      // depends_on. That cannot start, since the group's status comes
      // from contained work. Treat those children as the group's work.
      await repairEmptyPlanDependencies(ctx, c, swarm);
      // A planner interrupted after creating the tree can leave every
      // leaf open, which the coordinator deliberately does not spawn.
      // Assign all open leaves now; its dependency check will hold each
      // descendant until its prerequisite has finished.
      await releaseOpenSwarmLeaves(ctx, c, swarm);
      const now = new Date();
      const [started] = await db(c, ctx)
        .update(swarms)
        .set({ status: "running", pausedReason: null, branchReleasedAt: null, updatedAt: now })
        .where(eq(swarms.id, swarm.id))
        .returning();
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      saySwarmChanged(ctx, c, swarm, "running");
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
         * Whether this swarm can be reopened at all is asked first,
         * off the row already in hand, because it is the refusal a
         * person is most likely to hit and the one they can act on. A
         * swarm that is still running gets "there is nothing to
         * reopen" rather than "an agent is still finishing", which is
         * true of every running swarm and says nothing.
         */
        const cannot = reopenRefusal(swarm, {
          ...(body.budgetUsd === undefined ? {} : { budgetUsd: body.budgetUsd }),
          ...(body.timeLimitMin === undefined ? {} : { timeLimitMin: body.timeLimitMin }),
        });
        if (cannot) return c.json({ error: cannot.refused, code: cannot.code }, 409);

        /*
         * Then, on a swarm that has finished: one whose last agent has
         * not settled yet is one the coordinator is still about to
         * hear from, and its report would land on a tree this request
         * is about to change under it. Waiting a moment is the whole
         * fix.
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

        if (swarm.branchReleasedAt && swarm.branchName && !(await swarmCloneWorkspace(ctx, c, swarm))) {
          const repos = await db(c, ctx)
            .select({ name: repositories.name, localPath: repositories.localPath })
            .from(repositories)
            .where(eq(repositories.projectId, swarm.projectId));
          for (const repo of repos) {
            const checkout = await branchCheckoutPath(repo.localPath, swarm.branchName);
            if (checkout) {
              return c.json({
                error: `Switch ${repo.name} to another branch before reopening this swarm. ${swarm.branchName} is checked out at ${checkout}.`,
                code: "BRANCH_IN_USE",
              }, 409);
            }
          }
        }

        const reopened = await db(c, ctx).transaction((tx) =>
          reopenSwarm(tx as unknown as Db, swarm, {
            instruction: body.instruction,
            ...(body.budgetUsd === undefined ? {} : { budgetUsd: body.budgetUsd }),
            ...(body.timeLimitMin === undefined ? {} : { timeLimitMin: body.timeLimitMin }),
            actorUserId: actor(c),
          }),
        );
        if ("refused" in reopened) return c.json({ error: reopened.refused, code: reopened.code }, 409);

        // The planner hears the instruction through the wake the tick
        // delivers, which is the same door every other message uses.
        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        saySwarmChanged(ctx, c, swarm, "running");
        return c.json({ swarm: reopened.swarm, followUpTaskId: reopened.followUpTaskId, followUp: reopened.followUp }, 201);
      },
    )
    /**
     * What this swarm produced for people to read: its assembled
     * document, and anything else its agents captured.
     *
     * Metadata only. The bytes are served by the artifact routes, which
     * is where every rule about serving agent output lives: a sandboxing
     * CSP, nosniff, and HTML offered as a download rather than rendered.
     * Duplicating any of that here would be a second place for it to
     * drift out of date.
     */
    /**
     * The bytes of one plan source, for the console: an image drawn
     * under the goal, a PDF offered as a download, a text file as it
     * was uploaded.
     *
     * Resolved through the swarm and the row, never through the key:
     * a key is bookkeeping, and nothing is served because one matched.
     * The headers are the artifact route's, for the artifact route's
     * reason: a person's upload is not this app, and must never run
     * as it. Images are safe inline because an image element runs
     * nothing; a PDF viewer runs script and SVG can carry it, so both
     * download.
     */
    .get("/:id/plan-sources/:sourceId/content", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);
      const sourceId = c.req.param("sourceId");
      if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return c.json({ error: "not found" }, 404);
      const [source] = await db(c, ctx)
        .select()
        .from(swarmPlanSources)
        .where(and(eq(swarmPlanSources.id, sourceId), eq(swarmPlanSources.swarmId, swarm.id)))
        .limit(1);
      if (!source) return c.json({ error: "not found" }, 404);

      // Sources are immutable, so the id is the strongest ETag there is.
      const etag = `"${source.id}"`;
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);

      let body: Buffer | null = null;
      let mime = source.mime;
      if (source.storageKey) {
        if (!ctx.artifacts) return c.json({ error: "this deployment has no artifact storage configured" }, 503);
        body = await ctx.artifacts.get(source.storageKey);
      } else if (source.content !== null) {
        body = Buffer.from(source.content, "utf8");
        // A page's text is served as text, not as the HTML it was
        // stripped from, and nothing text-shaped is given a type a
        // browser would render as markup.
        mime = source.mime === "text/markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
      }
      // The row outlived its bytes, which is a true answer rather than
      // an error to dress up: the object was removed from the store.
      if (body === null) return c.json({ error: "not found" }, 404);

      c.header("content-type", mime);
      c.header("x-content-type-options", "nosniff");
      c.header("content-security-policy", "sandbox");
      c.header("cache-control", "private, max-age=3600");
      c.header("etag", etag);
      const mode = PLAN_SOURCE_INLINE_MIMES.has(source.mime) ? "inline" : "attachment";
      c.header("content-disposition", `${mode}; filename="${headerSafeName(source.name)}"`);
      return c.body(new Uint8Array(body));
    })
    .get("/:id/artifacts", async (c) => {
      const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
      if (!swarm) return c.json({ error: "not found" }, 404);
      const refusal = await requireSwarms(ctx, c, swarm.organizationId);
      if (refusal) return c.json(refusal.body, refusal.status);

      const rows = await db(c, ctx)
        .select({
          id: runArtifacts.id,
          runId: runArtifacts.runId,
          swarmTaskId: runArtifacts.swarmTaskId,
          stageSlug: runArtifacts.stageSlug,
          stageName: runArtifacts.stageName,
          path: runArtifacts.path,
          kind: runArtifacts.kind,
          mime: runArtifacts.mime,
          size: runArtifacts.size,
          createdAt: runArtifacts.createdAt,
        })
        .from(runArtifacts)
        .where(eq(runArtifacts.swarmId, swarm.id))
        .orderBy(desc(runArtifacts.createdAt))
        .limit(SWARM_ARTIFACTS_SHOWN);
      return c.json(rows);
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

        const message = await recordSwarmAnswer(db(c, ctx), {
          swarmId: swarm.id,
          taskId: body.taskId ?? null,
          text: body.text,
          userId: actor(c),
        });
        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        return c.json(message, 201);
      },
    )
    /**
     * Adds a task to the plan, because a person saw something the
     * planner did not.
     *
     * The other half of a tree a person and an agent share. It goes in
     * assigned, because somebody who adds a task has decided it needs
     * doing and leaving it open would be the planner overruling them
     * by inaction, and the planner is told about it in the same breath
     * and can cancel it: objecting is a decision somebody can see.
     *
     * Through the same function the planner's own create_task will use
     * when it grows one, for the reason every other node control is
     * shared: one rule about what may hang off what, not two.
     */
    .post(
      "/:id/tasks",
      zValidator(
        "json",
        z
          .object({
            parentId: z.string().uuid().nullish(),
            title: z.string().trim().min(1).max(200),
            description: z.string().max(20_000).optional(),
            weight: z.number().int().min(1).max(5).optional(),
          })
          .strict(),
      ),
      async (c) => {
        const swarm = await getAccessibleSwarm(ctx, c, c.req.param("id"));
        if (!swarm) return c.json({ error: "not found" }, 404);
        const refusal = await requireSwarms(ctx, c, swarm.organizationId);
        if (refusal) return c.json(refusal.body, refusal.status);
        const body = c.req.valid("json");

        if (swarm.status === "cancelled") {
          return c.json(
            { error: "This swarm is stopped, so nothing more is added to its plan.", code: "SWARM_STOPPED" },
            409,
          );
        }
        if (swarm.status === "done" || swarm.status === "failed") {
          return c.json(
            {
              error: "This swarm has finished. Reopen it with the follow up before adding more work.",
              code: "SWARM_FINISHED",
            },
            409,
          );
        }

        /*
         * The parent, scoped to this swarm rather than looked up by id
         * alone, so a node from another team's swarm reads as not
         * there rather than as one this caller may add work under.
         */
        let parent: typeof swarmTasks.$inferSelect | null = null;
        if (body.parentId) {
          const [row] = await db(c, ctx)
            .select()
            .from(swarmTasks)
            .where(and(eq(swarmTasks.id, body.parentId), eq(swarmTasks.swarmId, swarm.id)))
            .limit(1);
          if (!row) return c.json({ error: "not found" }, 404);
          parent = row;
        }

        const created = await addLeaf(db(c, ctx), {
          swarmId: swarm.id,
          parent,
          title: body.title,
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.weight === undefined ? {} : { weight: body.weight }),
          actorUserId: actor(c),
        });
        if ("refused" in created) return c.json({ error: created.refused, code: "CANNOT_ADD" }, 409);

        /*
         * And the planner hears about it, as a notice rather than as a
         * message: this is Bento's sentence about a row it holds, with
         * the person's own words quoted inside it.
         */
        await db(c, ctx).insert(swarmMessages).values({
          swarmId: swarm.id,
          source: "system",
          text: addedTaskNotice({
            taskId: created.id,
            title: created.title,
            description: created.description,
            parentId: created.parentId,
            quote: quoteUntrusted,
          }),
        });

        deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
        saySwarmChanged(ctx, c, swarm);
        return c.json(created, 201);
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

      const runs = await db(c, ctx)
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          queuedAt: agentRuns.queuedAt,
          startedAt: agentRuns.startedAt,
          endedAt: agentRuns.endedAt,
          error: agentRuns.error,
          sandboxProvider: agentRuns.sandboxProvider,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.swarmTaskId, task.id), eq(agentRuns.role, "worker")))
        .orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id));

      const commits = await taskCommits(ctx, c, swarm, task);
      const retryable = await landingRetryableTasks(ctx, c, swarm, [task]);
      return c.json({
        task: { ...task, canRetryLanding: retryable.has(task.id) },
        events,
        runs: await runsForCaller(ctx, c, runs),
        commits,
      });
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
      /*
       * Done by hand is done without the merge queue, so the branch
       * leaves it: a queued row would land work on a task that is
       * already finished, and a failed one kept offering to. A landing
       * moving the branch right now is waited for, the way a retry
       * waits for it.
       */
      if ((await withdrawTaskLandings(db(c, ctx), task.id, now)) === "landing") {
        return c.json({ error: LANDING_IN_FLIGHT, code: "LANDING_IN_FLIGHT" }, 409);
      }
      const [done] = await db(c, ctx)
        .update(swarmTasks)
        .set({
          status: "done",
          // Nothing is waiting on a finished node, and an attention
          // flag left behind would keep it lit on a board whose whole
          // job is saying where to look.
          attention: null,
          assignedRunId: null,
          // Nor a merge queue failure: it is about a landing that is
          // not going to happen, and it kept a retry on offer.
          flags: { ...task.flags, landingError: undefined, landingErrorCode: undefined },
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
      saySwarmChanged(ctx, c, swarm);
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
      const body = await c.req.json().catch(() => ({}));
      const parsed = z
        .object({ reason: z.string().trim().min(1).max(4000).optional(), fresh: z.boolean().optional() })
        .safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid retry request" }, 400);
      const fresh = parsed.data.fresh === true;
      const finished = swarm.status === "failed" ? null : finishedTaskMutationRefusal(c, swarm);
      if (finished) return finished;

      /*
       * Whether this may be retried at all is asked before anything is
       * touched, the way split asks it. A refusal that has already
       * killed an agent is a route that destroyed a branch and then
       * told the caller nothing had changed: the planner's own cancel
       * lets a worker finish its turn, so a cancelled leaf can still
       * have an agent on it, and that leaf is exactly the one somebody
       * reaches for Retry on.
       */
      const refusedFor = retryRefusal(task, { fresh });
      if (refusedFor) return c.json({ error: refusedFor, code: "NOT_A_LEAF" }, 409);
      /*
       * Every retry takes the branch out of the merge queue first, not
       * only a start over. A start over discards the branch; a plain
       * retry puts a new worker on it, whose report is accepted or not
       * on its own. A queued row of the old attempt left behind landed
       * the old branch and marked the task done under the new worker.
       * One being landed this moment is the one thing this waits for.
       */
      if ((await withdrawTaskLandings(db(c, ctx), task.id, new Date())) === "landing") {
        return c.json({ error: LANDING_IN_FLIGHT, code: "LANDING_IN_FLIGHT" }, 409);
      }

      /*
       * Then the agent on it stops, and then the leaf goes back in the
       * queue. That order and not the other: the other starts a second
       * agent on a branch the first one is still committing to, which
       * is the one thing the merge queue cannot sort out afterwards.
       */
      /*
       * Starting over is cut from the swarm's branch. With the swarm's
       * machine gone, that branch is read back from GitHub, where every
       * landing pushed it; a swarm that never pushed (no GitHub) starts
       * the task from the base branch, which the console says before a
       * person confirms.
       */
      await stopRunsOnTask(ctx, c, task.id);
      const retried = await retryLeaf(db(c, ctx), {
        task,
        actorUserId: actor(c),
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(fresh ? { fresh: true } : {}),
      });
      if ("refused" in retried) return c.json({ error: retried.refused, code: "NOT_A_LEAF" }, 409);
      if (await reactivateSwarmForRetry(db(c, ctx), swarm.id)) {
        saySwarmChanged(ctx, c, swarm, "running");
      }
      // Starting over takes the old machine down in a job, not in this
      // request: a slow provider would time the request out with the
      // agent already stopped. The task reads "Restarting" until then.
      if (fresh) deferAfterCommit(c, () => enqueueTaskStartOver(ctx, task.id));
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      return c.json(retried);
    })
    .post("/:id/tasks/:taskId/landing/retry", async (c) => {
      const found = await accessibleTask(ctx, c);
      if ("refusal" in found) return found.refusal;
      const { swarm, task } = found;
      const [landing] = await db(c, ctx).select().from(swarmLandings)
        .where(and(eq(swarmLandings.swarmId, swarm.id), eq(swarmLandings.taskId, task.id), eq(swarmLandings.status, "failed")))
        .orderBy(desc(swarmLandings.createdAt)).limit(1);
      const [agentOnTask] = await db(c, ctx).select({ id: agentRuns.id }).from(agentRuns)
        .where(and(eq(agentRuns.swarmTaskId, task.id), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      // The same predicate the detail routes answer `canRetryLanding`
      // with, so the drawer offers exactly what this accepts.
      const refused = landingRetryRefusal({ swarm, task, failedLanding: !!landing, agentOnTask: !!agentOnTask });
      if (refused || !landing) {
        return c.json({ error: refused ?? "This task has no failed merge queue entry to retry.", code: "CANNOT_RETRY_LANDING" }, 409);
      }

      const now = new Date();
      const retried = await db(c, ctx).transaction(async (tx) => {
        /*
         * Requeued the way the planner's accept requeues a row: nothing
         * of the landing that failed (its count of tries, its resolver,
         * its backoff) is about this attempt, and a resolver id left on
         * it read as "the resolver already tried" and failed the next
         * conflict at once. It keeps its place in the queue, which is
         * ahead of anything accepted since: a person asked for this
         * branch to land, and it was accepted before the ones behind it.
         */
        const [row] = await tx.update(swarmLandings)
          .set(requeuedLanding(landing.branchName ?? task.branchName, landing.position, now))
          .where(and(eq(swarmLandings.id, landing.id), eq(swarmLandings.status, "failed")))
          .returning({ id: swarmLandings.id });
        if (!row) return false;
        await tx.update(swarmTasks)
          .set({
            status: "landed", attention: null, updatedAt: now,
            flags: { ...task.flags, landingError: undefined, landingErrorCode: undefined, plannerToldAt: now.toISOString(), plannerToldBy: undefined, plannerRetells: undefined },
          })
          .where(and(eq(swarmTasks.id, task.id), eq(swarmTasks.status, task.status)));
        await reactivateSwarmForRetry(tx as unknown as Db, swarm.id);
        await tx.insert(swarmTaskEvents).values({
          taskId: task.id, kind: "status_changed", fromStatus: task.status, toStatus: "landed",
          detail: { mergeQueueRetry: landing.id },
        });
        return true;
      });
      if (!retried) return c.json({ error: "This merge queue entry is already being retried." }, 409);
      deferAfterCommit(c, () => enqueueSwarmTick(ctx, swarm.id));
      saySwarmChanged(ctx, c, swarm, "running");
      return c.json({ landingId: landing.id, status: "queued" });
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
      // A failed swarm is the one a person unsticks by hand, so its
      // tasks can be cancelled the way they can be retried. Done and
      // stopped swarms go through reopen.
      const finished = swarm.status === "failed" ? null : finishedTaskMutationRefusal(c, swarm);
      if (finished) return finished;

      /*
       * The branches of the subtree leave the merge queue with it (see
       * cancelTaskTree). Asked first, over the whole subtree, so a
       * landing in flight refuses the request before anything is
       * cancelled rather than leaving half of it done.
       */
      const subtree = [task.id, ...(await descendantIds(db(c, ctx), task.id))];
      if ((await withdrawTaskLandings(db(c, ctx), subtree, new Date())) === "landing") {
        return c.json({ error: LANDING_IN_FLIGHT, code: "LANDING_IN_FLIGHT" }, 409);
      }

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
        // Allowed on a failed swarm for the reason cancel is: a leaf too
        // big to finish is one way a swarm fails.
        const finished = swarm.status === "failed" ? null : finishedTaskMutationRefusal(c, swarm);
        if (finished) return finished;

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
     * On the leaf rather than on the swarm, because the answer to
     * one task a cheap worker could not finish is a stronger agent on
     * that task, not a stronger agent on every task that has not
     * started yet. Null puts it back on the swarm's own worker.
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
        return c.json({ error: "Agents are working in this swarm. Stop it or wait for them to finish, then delete." }, 409);
      }

      /*
       * Read whole, destroyed ones included: their rows have to go too,
       * or the delete leaves exactly the pointerless row that is
       * supposed to mean a machine is adrift.
       */
      const owned = await db(c, ctx).select().from(sandboxes).where(eq(sandboxes.swarmId, swarm.id));
      for (const sandbox of owned.filter((row) => row.status !== "destroyed")) {
        try {
          const driver = driverForSandbox(ctx.drivers, sandbox);
          const handle: SandboxHandle = {
            externalId: sandbox.externalId,
            provider: driver.provider,
            workdir: sandbox.workdir,
            // A hibernated Modal machine is its image; without it the
            // image outlives the swarm and goes on billing.
            ...(sandbox.imageRef ? { imageRef: sandbox.imageRef } : {}),
          };
          await driver.destroy(handle);
        } catch (err) {
          return c.json(
            {
              error: `the sandbox could not be destroyed (${err instanceof Error ? err.message : String(err)}). The swarm was not deleted; try again`,
            },
            502,
          );
        }
      }

      /*
       * What the plan's PDFs and images hold in the store, read before
       * the rows go, and taken down once the delete has committed: a
       * row that is gone is not reachable, and an object that stayed
       * would only be bytes on a shelf nobody can ask for.
       */
      const planKeys = await planSourceStorageKeys(db(c, ctx), swarm.id);
      await db(c, ctx).delete(swarms).where(eq(swarms.id, swarm.id));
      if (planKeys.length > 0 && ctx.artifacts) {
        const store = ctx.artifacts;
        deferAfterCommit(c, async () => {
          await store.remove(planKeys);
        });
      }
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
 * Status-changing node controls on an ended swarm go through reopen.
 *
 * Retry, start over, cancel, split and the merge queue retry let a
 * failed swarm through (each says so where it asks), because a failed
 * swarm is the one a person unsticks by hand. The console mirrors this
 * in `taskActionRefusal`, so a change here belongs there too.
 */
function finishedTaskMutationRefusal(
  c: Context,
  swarm: Pick<typeof swarms.$inferSelect, "status">,
): Response | null {
  if (swarm.status !== "done" && swarm.status !== "failed" && swarm.status !== "cancelled") return null;
  return c.json(
    {
      error: "This swarm has finished. Reopen it before changing which work is active.",
      code: "SWARM_FINISHED",
    },
    409,
  );
}

/**
 * The tasks whose failed merge queue entry the landing retry route
 * would take right now, by `landingRetryRefusal`, the predicate the
 * route itself asks. Two queries for the whole tree rather than two per
 * task: which tasks have a failed row, and which have an agent on them.
 */
async function landingRetryableTasks(
  ctx: AppContext,
  c: Context,
  swarm: typeof swarms.$inferSelect,
  tasks: (typeof swarmTasks.$inferSelect)[],
): Promise<Set<string>> {
  const leaves = tasks.filter((task) => task.nodeType === "leaf").map((task) => task.id);
  if (leaves.length === 0) return new Set();
  const failed = await db(c, ctx)
    .selectDistinct({ taskId: swarmLandings.taskId })
    .from(swarmLandings)
    .where(and(eq(swarmLandings.swarmId, swarm.id), eq(swarmLandings.status, "failed"), inArray(swarmLandings.taskId, leaves)));
  if (failed.length === 0) return new Set();
  const failedIds = new Set(failed.map((row) => row.taskId));
  const busy = await db(c, ctx)
    .selectDistinct({ taskId: agentRuns.swarmTaskId })
    .from(agentRuns)
    .where(and(inArray(agentRuns.swarmTaskId, [...failedIds]), inArray(agentRuns.status, ACTIVE_RUN_STATUSES)));
  const busyIds = new Set(busy.map((row) => row.taskId));
  return new Set(
    tasks
      .filter((task) => landingRetryRefusal({
        swarm,
        task,
        failedLanding: failedIds.has(task.id),
        agentOnTask: busyIds.has(task.id),
      }) === null)
      .map((task) => task.id),
  );
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
