import { eq, inArray } from "drizzle-orm";
import { gateCriteria, type AgentCli } from "@bento/core";
import { agentProfiles, stages, type Db } from "@bento/db";
import { toolchainBinaries, type AgentBinary } from "@bento/sandbox";

/**
 * The agent binaries a card's sandbox has to be able to spawn.
 *
 * A sprite installs its CLIs on the way in, and there are ten of them,
 * so the first stage of a new card used to wait on every installer plus
 * a private Node it would never call. A pipeline that runs Claude Code
 * and Codex should wait for two.
 *
 * The set is the whole pipeline's, not this stage's, on purpose. A card
 * keeps one machine for its whole life, so installing the later stages'
 * agents while the first stage is already paying for a cold provision
 * costs nothing extra there and saves each later stage its own wait. It
 * also covers the judge a gate runs, which is an agent nothing else in
 * the stage would name.
 *
 * Narrowing this can never strand a run, and the reason is worth being
 * precise about, because the failure it would cause is the one
 * `TOOLCHAIN_VERSION` exists to remember: an agent that is absent at
 * spawn. Provisioning happens before every run, and the toolchain
 * script installs any asked-for CLI that is not on the PATH. So an
 * agent added to the pipeline after the card was created, or swapped
 * into a stage this morning, is simply missing from that sandbox on the
 * next provision and is installed then. `runCli` is unioned in
 * separately for the same reason: whatever the pipeline says, the agent
 * this run is about to spawn is in the set.
 */
export async function pipelineAgentBinaries(
  db: Db,
  input: { pipelineId: string; runCli: AgentCli },
): Promise<AgentBinary[]> {
  const pipelineStages = await db
    .select({ defaultAgentProfileId: stages.defaultAgentProfileId, gateCriteria: stages.gateCriteria })
    .from(stages)
    .where(eq(stages.pipelineId, input.pipelineId));

  const profileIds = new Set<string>();
  for (const stage of pipelineStages) {
    if (stage.defaultAgentProfileId) profileIds.add(stage.defaultAgentProfileId);
    // A gate's judge is an agent too, and it is named nowhere else.
    // Criteria are parsed rather than trusted: a stage carrying a shape
    // this version does not know contributes nothing, exactly as the
    // gate evaluator reads it.
    const parsed = gateCriteria.safeParse(stage.gateCriteria);
    if (!parsed.success) continue;
    for (const criterion of parsed.data) {
      if (criterion.type === "agent_judge") profileIds.add(criterion.agentProfileId);
    }
  }

  const clis: AgentCli[] = [input.runCli];
  if (profileIds.size > 0) {
    const profiles = await db
      .select({ cli: agentProfiles.cli })
      .from(agentProfiles)
      .where(inArray(agentProfiles.id, [...profileIds]));
    for (const profile of profiles) clis.push(profile.cli);
  }
  return toolchainBinaries(clis);
}
