import { asc, eq } from "drizzle-orm";
import {
  agentProfiles,
  agentRuns,
  features,
  projects,
  repositories,
  stages,
  swarmTasks,
  swarms,
} from "@bento/db";
import type { AppContext } from "../context.js";
import { BENTO_SWARM_SERVER_ID, BENTO_SWARM_SLUG } from "../mcp/swarm-server.js";
import { linkGitHubRemotes } from "./repo-remote.js";
import { swarmBranchName, swarmWorkspaceKey } from "./swarm/sandbox.js";
import { SWARM_TICK_QUEUE } from "./swarm/coordinator.js";
import type { PipelineRun } from "./pipeline-run.js";

/**
 * What a run is working on, resolved once at the top of the executor.
 *
 * agent_runs carries two boards, and the executor is one function on
 * purpose: a second copy of it would drift, and the parts that differ
 * between a card's run and a swarm's are few and specific. They are
 * exactly these: which rows the run hangs off, which workspace and
 * branch it gets, what its prompt is built from, which tools it is
 * given, where its artifacts are filed, what its board events say, and
 * what its settlement queues. Everything between those points is the
 * same work.
 *
 * So the differences are resolved here, once, into one value, and the
 * executor reads it. A new board would be a third case here rather
 * than a third executor.
 */

type Run = typeof agentRuns.$inferSelect;

interface CommonSubject {
  run: Run;
  profile: typeof agentProfiles.$inferSelect;
  project: typeof projects.$inferSelect;
  organizationId: string | null;
  repoRows: (typeof repositories.$inferSelect)[];
  /** The branch this run's work is on. */
  branch: string;
  /** Names the workspace directory and the machine; see provisionWorkspace. */
  workspaceKey: string;
  /** Which rows the sandbox belongs to. */
  sandboxOwner: { featureId: string } | { swarmId: string; swarmTaskId?: string | null };
  /** The label a pre-run snapshot is taken under. */
  snapshotLabel: string;
  /** Bento's own MCP servers this run is given, beyond the team's. */
  ownMcpServers: { id: string; slug: string }[];
  /** Tells the board this run changed state. */
  emitBoard(status: string): void;
  /** Tells the board what the agent last said. */
  emitOutput(text: string): void;
  /** What to queue once the run has settled. */
  settle(ctx: AppContext): Promise<void>;
}

export interface PipelineSubject extends CommonSubject {
  kind: "pipeline";
  run: PipelineRun;
  feature: typeof features.$inferSelect;
  stage: typeof stages.$inferSelect;
}

export interface SwarmSubject extends CommonSubject {
  kind: "swarm";
  swarm: typeof swarms.$inferSelect;
  /** The leaf this run works, for a worker or a sub planner. */
  task: typeof swarmTasks.$inferSelect | null;
}

export type RunSubject = PipelineSubject | SwarmSubject;

/**
 * Reads everything a run needs, and refuses a row whose references
 * cross a boundary.
 *
 * The tenant checks are repeated here rather than trusted from the
 * insert triggers, because this is the last point before a sandbox is
 * provisioned with somebody's code in it, and a check that only ran at
 * insert time cannot see a row that was repointed since.
 */
export async function describeRunSubject(ctx: AppContext, run: Run): Promise<RunSubject> {
  const [profile] = await ctx.db.select().from(agentProfiles).where(eq(agentProfiles.id, run.agentProfileId));
  if (!profile) throw new Error(`run ${run.id} has dangling references`);

  return run.type === "swarm"
    ? swarmSubject(ctx, run, profile)
    : pipelineSubject(ctx, run, profile);
}

async function pipelineSubject(
  ctx: AppContext,
  run: Run,
  profile: typeof agentProfiles.$inferSelect,
): Promise<PipelineSubject> {
  if (!run.featureId || !run.stageId) throw new Error(`run ${run.id} names no card`);
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, run.featureId));
  const [stage] = await ctx.db.select().from(stages).where(eq(stages.id, run.stageId));
  if (!feature || !stage) throw new Error(`run ${run.id} has dangling references`);
  if (
    stage.pipelineId !== feature.pipelineId
    || stage.organizationId !== feature.organizationId
    || profile.organizationId !== feature.organizationId
  ) {
    throw new Error(`run ${run.id} crosses a project or organization boundary`);
  }
  const project = await requireProject(ctx, feature.projectId);
  if (project.organizationId !== feature.organizationId) {
    throw new Error(`run ${run.id} has a feature outside its project organization`);
  }
  const repoRows = await repositoriesFor(ctx, project.id);

  return {
    kind: "pipeline",
    run: run as PipelineRun,
    profile,
    feature,
    stage,
    project,
    organizationId: feature.organizationId,
    repoRows,
    branch: feature.branchName ?? `feature/${feature.id.slice(0, 8)}`,
    workspaceKey: feature.id,
    sandboxOwner: { featureId: feature.id },
    snapshotLabel: `before ${stage.name}`,
    // A card's agent gets the team's servers and nothing of Bento's:
    // the pipeline's own verbs are the board, not tools.
    ownMcpServers: [],
    emitBoard: (status) =>
      ctx.bus.emitBoardEvent({
        type: "run_updated",
        projectId: feature.projectId,
        featureId: feature.id,
        runId: run.id,
        status,
      }),
    emitOutput: (text) =>
      ctx.bus.emitBoardEvent({
        type: "run_output",
        projectId: feature.projectId,
        featureId: feature.id,
        runId: run.id,
        text,
      }),
    settle: async (context) => {
      await context.boss.send("gate.evaluate", { featureId: feature.id });
    },
  };
}

async function swarmSubject(
  ctx: AppContext,
  run: Run,
  profile: typeof agentProfiles.$inferSelect,
): Promise<SwarmSubject> {
  if (!run.swarmId) throw new Error(`run ${run.id} names no swarm`);
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, run.swarmId));
  if (!swarm) throw new Error(`run ${run.id} has dangling references`);
  if (profile.organizationId !== swarm.organizationId) {
    throw new Error(`run ${run.id} crosses a project or organization boundary`);
  }
  const task = run.swarmTaskId
    ? (await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.id, run.swarmTaskId)))[0] ?? null
    : null;
  if (run.swarmTaskId && !task) throw new Error(`run ${run.id} has dangling references`);
  if (task && task.swarmId !== swarm.id) throw new Error(`run ${run.id} crosses a swarm boundary`);

  const project = await requireProject(ctx, swarm.projectId);
  if (project.organizationId !== swarm.organizationId) {
    throw new Error(`run ${run.id} has a swarm outside its project organization`);
  }
  const repoRows = await repositoriesFor(ctx, project.id);

  /**
   * A worker gets its own machine and its own branch off the swarm's;
   * everything that acts on the swarm as a whole (the planner, the
   * merge queue's resolver) shares the swarm's machine and its branch.
   * A worker on the swarm's own branch would be several agents
   * committing to one branch, which is the thing the merge queue
   * exists to avoid.
   */
  const perTask = (run.role === "worker" || run.role === "subplanner") && task;
  const branch = perTask
    ? (task.branchName ?? `${swarm.branchName ?? swarmBranchName(swarm.slug)}/${task.id.slice(0, 8)}`)
    : (swarm.branchName ?? swarmBranchName(swarm.slug));

  return {
    kind: "swarm",
    run,
    profile,
    swarm,
    task,
    project,
    organizationId: swarm.organizationId,
    repoRows,
    branch,
    workspaceKey: perTask ? `${swarmWorkspaceKey(swarm.id)}-${task.id.slice(0, 8)}` : swarmWorkspaceKey(swarm.id),
    sandboxOwner: { swarmId: swarm.id, swarmTaskId: task?.id ?? null },
    snapshotLabel: `before ${run.role}`,
    // The plan is made through tools, so every swarm agent gets Bento's
    // own server. Which of its tools the agent may call is decided per
    // call from the run's role, not by handing out different servers.
    ownMcpServers: [{ id: BENTO_SWARM_SERVER_ID, slug: BENTO_SWARM_SLUG }],
    emitBoard: (status) =>
      ctx.bus.emitBoardEvent({
        type: task ? "swarm_task_updated" : "swarm_updated",
        projectId: swarm.projectId,
        swarmId: swarm.id,
        ...(task ? { taskId: task.id } : {}),
        status,
      }),
    // Nothing an agent said travels on a swarm's board event: a task's
    // line is read from its own transcript, and the event exists to say
    // that something changed.
    emitOutput: () => {},
    settle: async (context) => {
      // The reconciler, not a gate. Everything a finished swarm run
      // implies (a parent's status, the next worker, the landing queue)
      // is decided by reading the rows, so the settlement's whole job
      // is to say that they changed.
      await context.boss.send(SWARM_TICK_QUEUE, { swarmId: swarm.id }, { singletonKey: swarm.id });
    },
  };
}

async function requireProject(ctx: AppContext, projectId: string) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error(`project ${projectId} not found`);
  return project;
}

async function repositoriesFor(ctx: AppContext, projectId: string) {
  const selected = await ctx.db
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(asc(repositories.position));
  if (selected.length === 0) {
    throw new Error(`project ${projectId} has no repositories; add at least one before running agents`);
  }
  // Repositories added by path before their remote was read still have
  // no URL, which anything that publishes would report as "no GitHub
  // remote is linked". Read it from the checkout once.
  return ctx.env.BENTO_MODE === "multi" ? selected : linkGitHubRemotes(ctx.db, selected);
}
