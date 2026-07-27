import { DEFAULT_AGENTS, DEFAULT_STAGES, MODEL_GUIDANCE } from "@bento/core";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentProfiles, pipelines, stages } from "./schema/index.js";

/** The tool a seeded agent runs, and the model it runs on. */
const SEED_CLI = "claude-code" as const;
const SEED_MODEL = MODEL_GUIDANCE.find((tool) => tool.cli === SEED_CLI)?.defaultModel ?? "claude-sonnet-5";

/**
 * Creates the default six stage pipeline for a project, with an agent
 * on each stage.
 *
 * The stages alone were never enough to run anything: a new board had
 * six lanes and nothing assigned, so the first thing anybody did was
 * invent six job titles from scratch before they could watch a card
 * move. Seeding the agents too means a fresh install can run its first
 * card immediately, and every part of it is editable afterwards.
 *
 * Agents are seeded only for an owner who has none by those names. A
 * second project reuses the ones already there rather than making a
 * second set that says the same thing.
 */
export async function seedDefaultPipeline(
  db: Db,
  projectId: string,
  owner?: { ownerId: string; organizationId: string | null },
): Promise<string> {
  const [pipeline] = await db
    .insert(pipelines)
    .values({ projectId, name: "Default", isDefault: true })
    .returning({ id: pipelines.id });
  if (!pipeline) throw new Error("failed to create default pipeline");

  const agents = owner ? await ensureDefaultAgents(db, owner) : new Map<string, string>();

  await db.insert(stages).values(
    DEFAULT_STAGES.map((stage, i) => ({
      pipelineId: pipeline.id,
      position: i,
      name: stage.name,
      slug: stage.slug,
      description: stage.description,
      gateType: stage.gateType,
      gateCriteria: stage.gateCriteria as unknown[],
      ...(agents.has(stage.slug) ? { defaultAgentProfileId: agents.get(stage.slug)! } : {}),
    })),
  );

  return pipeline.id;
}

/**
 * The default agents, keyed by the stage slug each one runs.
 *
 * Matched on name rather than created blindly: somebody who already has
 * a "Code Reviewer" gets theirs assigned instead of a duplicate.
 */
async function ensureDefaultAgents(
  db: Db,
  owner: { ownerId: string; organizationId: string | null },
): Promise<Map<string, string>> {
  const existing = await db.select().from(agentProfiles).where(eq(agentProfiles.ownerId, owner.ownerId));
  const byName = new Map(existing.map((profile) => [profile.name, profile.id]));

  const missing = DEFAULT_AGENTS.filter((agent) => !byName.has(agent.name));
  if (missing.length > 0) {
    const created = await db
      .insert(agentProfiles)
      .values(
        missing.map((agent) => ({
          ownerId: owner.ownerId,
          organizationId: owner.organizationId,
          name: agent.name,
          cli: SEED_CLI,
          model: SEED_MODEL,
          skill: agent.skill,
        })),
      )
      .returning({ id: agentProfiles.id, name: agentProfiles.name });
    for (const profile of created) byName.set(profile.name, profile.id);
  }

  const bySlug = new Map<string, string>();
  for (const agent of DEFAULT_AGENTS) {
    const id = byName.get(agent.name);
    if (id) bySlug.set(agent.stageSlug, id);
  }
  return bySlug;
}
