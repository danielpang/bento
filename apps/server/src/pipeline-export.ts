import { asc, eq, inArray, sql } from "drizzle-orm";
import { agentProfiles, pipelines, repositories, stages, type Db } from "@bento/db";
import { type AgentFile } from "./agent-file.js";
import { pipelineFile, type PipelineFile } from "./pipeline-file.js";

/**
 * The stored rows as the two files people keep beside their code.
 *
 * Shared by the export routes, which hand the document to the person,
 * and by the repository publish, which commits it for them. One
 * builder each, so the file a pull request carries is byte for byte
 * the one the Export button would have written.
 */

/**
 * A project's pipeline as a file, or the reason it cannot be one.
 *
 * Null when the project has no pipeline. An error means stored rows
 * this format cannot express, which is the format trailing the schema
 * rather than the data being wrong.
 */
export async function buildPipelineFile(
  database: Db,
  projectId: string,
): Promise<{ file: PipelineFile } | { error: string } | null> {
  const [pipeline] = await database.select().from(pipelines).where(eq(pipelines.projectId, projectId));
  if (!pipeline) return null;

  const [stageRows, repoRows] = await Promise.all([
    database.select().from(stages).where(eq(stages.pipelineId, pipeline.id)).orderBy(asc(stages.position)),
    database.select().from(repositories).where(eq(repositories.projectId, projectId)).orderBy(asc(repositories.position)),
  ]);
  const usedIds = [...new Set(stageRows.map((s) => s.defaultAgentProfileId).filter((id): id is string => !!id))];
  const agentRows = usedIds.length
    ? await database.select().from(agentProfiles).where(inArray(agentProfiles.id, usedIds))
    : [];
  const nameById = new Map(agentRows.map((agent) => [agent.id, agent.name]));

  const file = {
    version: 1 as const,
    pipeline: {
      name: pipeline.name,
      stages: stageRows.map((stage) => ({
        name: stage.name,
        slug: stage.slug,
        description: stage.description ?? "",
        gate: stage.gateType,
        requirements: Array.isArray(stage.gateCriteria) ? stage.gateCriteria : [],
        createPr: stage.createPr,
        agent: stage.defaultAgentProfileId ? (nameById.get(stage.defaultAgentProfileId) ?? null) : null,
      })),
    },
    agents: agentRows.map((agent) => ({
      name: agent.name,
      tool: agent.cli,
      model: agent.model,
      skill: agent.skill ?? null,
      extraArgs: agent.extraArgs ?? [],
    })),
    repositories: repoRows
      .filter((repo) => repo.setupCommand || repo.testCommand)
      .map((repo) => ({ name: repo.name, setup: repo.setupCommand, test: repo.testCommand })),
  };
  const parsed = pipelineFile.safeParse(file);
  if (!parsed.success) return { error: "this pipeline cannot be exported yet; please report it" };
  return { file: parsed.data };
}

/**
 * Every named agent a person owns, as a file.
 *
 * Written from the rows themselves, not re-validated against the import
 * cap: a roster can grow past what one file will accept, and refusing
 * to export it would trap the agents in this database.
 */
export async function buildAgentFile(database: Db, ownerId: string): Promise<AgentFile> {
  const rows = await database
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.ownerId, ownerId))
    .orderBy(sql`lower(${agentProfiles.name})`, asc(agentProfiles.id));
  return {
    version: 1,
    agents: rows.map((agent) => ({
      name: agent.name,
      tool: agent.cli,
      model: agent.model,
      skill: agent.skill ?? null,
      extraArgs: Array.isArray(agent.extraArgs) ? agent.extraArgs : [],
    })),
  };
}
