import { eq, inArray } from "drizzle-orm";
import { gateCriteria, type AgentCli } from "@bento/core";
import { agentProfiles, stages, type Db } from "@bento/db";
import { toolchainBinaries, type AgentBinary } from "@bento/sandbox";

/**
 * The agent binaries a card's pipeline uses: the set worth baking into
 * a machine image.
 *
 * This is not what a run waits for. A sprite installs its CLIs on the
 * way in, and there only the agent the run is about to spawn is asked
 * for (`agentBinaries` in the executor), so a card's first stage waits
 * on one installer rather than on the agents of stages it has not
 * reached. Each later stage names its own agent the same way, and the
 * driver installs it when the machine does not have it.
 *
 * Modal is where the whole pipeline still matters. Its machines come
 * from an image built once per set of CLIs and cached by name, so the
 * wider set costs a new card nothing, saves its later stages an
 * install inside the machine, and is the only way those stages get
 * their agent on a locked network, where no installer is reachable.
 * It also covers the judge a gate runs, which is an agent nothing
 * else in the stage would name.
 *
 * Only the stages that assign an agent. A stage left unassigned names
 * nobody here and is run by whoever a person or a follow-up picks at
 * the time. `runCli` is unioned in so that, whatever the pipeline
 * says, the agent this run is about to spawn is in the image made for
 * it.
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
