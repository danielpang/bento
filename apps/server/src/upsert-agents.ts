import { eq } from "drizzle-orm";
import { checkAgentPairing } from "@bento/core";
import { agentProfiles, type Db } from "@bento/db";
import type { AgentEntry } from "./agent-file.js";

/**
 * Creates or updates the caller's agents from a file, matched by name.
 *
 * The same write both the agents file and the pipeline file use, so a
 * pairing the form would refuse is refused here too, and importing
 * twice edits rather than duplicating.
 */
export async function upsertAgentsFromFile(
  database: Db,
  agents: AgentEntry[],
  owner: { ownerId: string; organizationId: string | null },
): Promise<{ idsByName: Map<string, string> } | { error: string }> {
  for (const agent of agents) {
    const pairing = checkAgentPairing(agent.tool, agent.model);
    if (pairing.status === "impossible") {
      return { error: `agent "${agent.name}": ${pairing.detail}` };
    }
  }

  const owned = await database.select().from(agentProfiles).where(eq(agentProfiles.ownerId, owner.ownerId));
  const idsByName = new Map(owned.map((agent) => [agent.name, agent.id]));
  for (const agent of agents) {
    const existingId = idsByName.get(agent.name);
    const values = {
      name: agent.name,
      cli: agent.tool,
      model: agent.model,
      skill: agent.skill ?? null,
      extraArgs: agent.extraArgs,
    };
    if (existingId) {
      await database.update(agentProfiles).set(values).where(eq(agentProfiles.id, existingId));
    } else {
      const [created] = await database
        .insert(agentProfiles)
        .values({ ...values, ownerId: owner.ownerId, organizationId: owner.organizationId })
        .returning({ id: agentProfiles.id });
      if (created) idsByName.set(agent.name, created.id);
    }
  }
  return { idsByName };
}
