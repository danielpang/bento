import { asc, count, eq } from "drizzle-orm";
import { features, pipelines, repositories, stages, type Db } from "@bento/db";
import type { PipelineFile } from "./pipeline-file.js";
import { upsertAgentsFromFile } from "./upsert-agents.js";

export interface PipelineApplySummary {
  stages: number;
  agents: number;
  removedStages: string[];
  /**
   * Named rather than swallowed: a file written for another project
   * can carry commands for checkouts this one lacks.
   */
  skippedRepositories: string[];
}

export type PipelineApplyResult =
  | { ok: true; summary: PipelineApplySummary }
  /** 404 when the project has no pipeline, 409 when cards block it, 400 otherwise. */
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Applies a pipeline file to a project.
 *
 * Stages are matched by slug and updated in place, so importing over a
 * live board keeps the cards where they are. A stage the file leaves
 * out is removed only when nothing is sitting in it; otherwise the
 * import refuses and names it, because silently moving somebody's cards
 * is not an import.
 *
 * Every refusal happens before anything is written, agents included, so
 * a rejected file changes nothing at all. The import route and the
 * repository sync both come through here; a file the button would
 * refuse is refused from the repository too.
 */
export async function applyPipelineFile(
  database: Db,
  args: {
    projectId: string;
    file: PipelineFile;
    owner: { ownerId: string; organizationId: string | null };
  },
): Promise<PipelineApplyResult> {
  const { projectId, file } = args;
  const [pipeline] = await database.select().from(pipelines).where(eq(pipelines.projectId, projectId));
  if (!pipeline) return { ok: false, status: 404, error: "not found" };

  const existingStages = await database
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, pipeline.id))
    .orderBy(asc(stages.position));
  const bySlug = new Map(existingStages.map((stage) => [stage.slug, stage]));
  const wanted = new Set(file.pipeline.stages.map((stage) => stage.slug));

  const doomed = existingStages.filter((stage) => !wanted.has(stage.slug));
  for (const stage of doomed) {
    const [{ held } = { held: 0 }] = await database
      .select({ held: count(features.id) })
      .from(features)
      .where(eq(features.currentStageId, stage.id));
    if (Number(held) > 0) {
      return {
        ok: false,
        status: 409,
        error: `this file has no "${stage.name}" stage, and ${held} card${
          Number(held) === 1 ? " is" : "s are"
        } sitting in it. Move them first, or add that stage to the file.`,
      };
    }
  }

  // Agents before stages: a stage cannot point at one that does not
  // exist yet. Matched by name, so importing twice edits rather than
  // duplicates.
  const applied = await upsertAgentsFromFile(database, file.agents, args.owner);
  if ("error" in applied) return { ok: false, status: 400, error: applied.error };
  const agentIdByName = applied.idsByName;

  for (const [position, entry] of file.pipeline.stages.entries()) {
    const values = {
      name: entry.name,
      description: entry.description,
      gateType: entry.gate,
      gateCriteria: entry.requirements as unknown[],
      createPr: entry.createPr,
      position,
      defaultAgentProfileId: entry.agent ? (agentIdByName.get(entry.agent) ?? null) : null,
    };
    const existing = bySlug.get(entry.slug);
    if (existing) {
      await database.update(stages).set(values).where(eq(stages.id, existing.id));
    } else {
      await database.insert(stages).values({ ...values, pipelineId: pipeline.id, slug: entry.slug });
    }
  }
  for (const stage of doomed) {
    await database.delete(stages).where(eq(stages.id, stage.id));
  }
  if (file.pipeline.name !== pipeline.name) {
    await database.update(pipelines).set({ name: file.pipeline.name }).where(eq(pipelines.id, pipeline.id));
  }

  // Repository commands, where a checkout of that name exists here.
  const repoRows = await database.select().from(repositories).where(eq(repositories.projectId, projectId));
  const skippedRepositories: string[] = [];
  for (const entry of file.repositories) {
    const target = repoRows.find((repo) => repo.name === entry.name);
    if (!target) {
      skippedRepositories.push(entry.name);
      continue;
    }
    await database
      .update(repositories)
      .set({ setupCommand: entry.setup ?? null, testCommand: entry.test ?? null })
      .where(eq(repositories.id, target.id));
  }

  return {
    ok: true,
    summary: {
      stages: file.pipeline.stages.length,
      agents: file.agents.length,
      removedStages: doomed.map((stage) => stage.name),
      skippedRepositories,
    },
  };
}
