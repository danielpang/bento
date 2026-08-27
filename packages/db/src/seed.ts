import { DEFAULT_STAGES, defaultPipelineSeed, type PipelineSeed, type PipelineSeedAgent } from "@bento/core";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentProfiles, organizationPolicies, pipelines, projects, stages } from "./schema/index.js";

/**
 * Creates the default pipeline for a project, with an agent on each
 * stage.
 *
 * The stages alone were never enough to run anything: a new board had
 * six lanes and nothing assigned, so the first thing anybody did was
 * invent six job titles from scratch before they could watch a card
 * move. Seeding the agents too means a fresh install can run its first
 * card immediately, and every part of it is editable afterwards.
 *
 * An organization that finished setup stores the pipeline it chose;
 * that seed wins over the catalog defaults so the second project looks
 * like the first. An explicit seed from the caller wins over both.
 *
 * Agents are seeded only for an owner who has none by those names. A
 * second project reuses the ones already there rather than making a
 * second set that says the same thing.
 */
export async function seedDefaultPipeline(
  db: Db,
  projectId: string,
  owner?: { ownerId: string; organizationId: string | null },
  seed?: PipelineSeed,
): Promise<string> {
  const [project] = await db
    .select({ organizationId: projects.organizationId, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const chosen = seed ?? (await pipelineSeedForOrg(db, project?.organizationId ?? null));
  const stageDefs = chosen?.stages ?? DEFAULT_STAGES;
  const agentDefs = chosen?.agents;

  const [pipeline] = await db
    .insert(pipelines)
    .values({ projectId, name: "Default", isDefault: true })
    .returning({ id: pipelines.id });
  if (!pipeline) throw new Error("failed to create default pipeline");

  const agents = await ensureSeedAgents(
    db,
    owner ?? { ownerId: project?.ownerId ?? "", organizationId: project?.organizationId ?? null },
    agentDefs,
    { create: Boolean(owner) },
  );

  await db.insert(stages).values(
    stageDefs.map((stage, i) => ({
      pipelineId: pipeline.id,
      position: i,
      name: stage.name,
      slug: stage.slug,
      description: stage.description,
      gateType: stage.gateType,
      gateCriteria: "gateCriteria" in stage ? (stage.gateCriteria as unknown[]) : [],
      ...(agents.has(stage.slug) ? { defaultAgentProfileId: agents.get(stage.slug)! } : {}),
    })),
  );

  return pipeline.id;
}

async function pipelineSeedForOrg(db: Db, organizationId: string | null): Promise<PipelineSeed | undefined> {
  if (!organizationId) return undefined;
  const [row] = await db
    .select({ pipelineSeed: organizationPolicies.pipelineSeed })
    .from(organizationPolicies)
    .where(eq(organizationPolicies.organizationId, organizationId))
    .limit(1);
  return (row?.pipelineSeed as PipelineSeed | null | undefined) ?? undefined;
}

/**
 * The agents to put on a new pipeline, keyed by the stage slug each
 * one runs.
 *
 * Matched on name rather than created blindly: somebody who already has
 * a "Code Reviewer" gets theirs assigned instead of a duplicate.
 */
export async function ensureSeedAgents(
  db: Db,
  owner: { ownerId: string; organizationId: string | null },
  agents?: PipelineSeedAgent[],
  opts?: { create?: boolean },
): Promise<Map<string, string>> {
  const wanted = agents ?? defaultPipelineSeed().agents;
  const existing = owner.organizationId
    ? await db.select().from(agentProfiles).where(eq(agentProfiles.organizationId, owner.organizationId))
    : owner.ownerId
      ? await db.select().from(agentProfiles).where(eq(agentProfiles.ownerId, owner.ownerId))
      : [];
  const byName = new Map(existing.map((profile) => [profile.name, profile.id]));

  const missing = wanted.filter((agent) => !byName.has(agent.name));
  if (opts?.create !== false && owner.ownerId && missing.length > 0) {
    const created = await db
      .insert(agentProfiles)
      .values(
        missing.map((agent) => ({
          ownerId: owner.ownerId,
          organizationId: owner.organizationId,
          name: agent.name,
          cli: agent.cli,
          model: agent.model,
          skill: agent.skill,
        })),
      )
      .returning({ id: agentProfiles.id, name: agentProfiles.name });
    for (const profile of created) byName.set(profile.name, profile.id);
  }

  const bySlug = new Map<string, string>();
  for (const agent of wanted) {
    const id = byName.get(agent.name);
    if (id) bySlug.set(agent.stageSlug, id);
  }
  return bySlug;
}
