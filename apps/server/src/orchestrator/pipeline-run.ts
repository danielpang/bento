import type { agentRuns } from "@bento/db";

export type AgentRunRow = typeof agentRuns.$inferSelect;

/**
 * A run the pipeline owns: a card, at a stage.
 *
 * agent_runs carries both boards now, so `featureId` and `stageId` are
 * nullable columns and every card path would otherwise have to check
 * them again, at every step, for as long as the pipeline exists. One
 * check per entry point instead, and everything downstream takes this
 * type. The point is not brevity: it is that a future edit cannot
 * forget the check, because a swarm run will not type as a card's.
 */
export type PipelineRun = AgentRunRow & {
  type: "pipeline";
  featureId: string;
  stageId: string;
};

/**
 * Whether this row is the pipeline's.
 *
 * Both halves are checked. The discriminator is the row's own statement
 * about which board it belongs to and the database refuses a row whose
 * columns disagree with it (agent_runs_pipeline_shape), so the id
 * checks are belt and braces: they are also what makes this a type
 * guard rather than a cast.
 */
export function isPipelineRun(run: AgentRunRow): run is PipelineRun {
  return run.type === "pipeline" && run.featureId !== null && run.stageId !== null;
}

/**
 * The same, for a caller with nowhere to put "this is not that kind of
 * run": a worker whose queue only ever carries card runs. Loud, because
 * reaching it means something enqueued a swarm run into the pipeline,
 * and quietly returning would leave that run queued forever.
 */
export function asPipelineRun(run: AgentRunRow): PipelineRun {
  if (!isPipelineRun(run)) {
    throw new Error(`run ${run.id} is a ${run.type} run, not a pipeline run`);
  }
  return run;
}
