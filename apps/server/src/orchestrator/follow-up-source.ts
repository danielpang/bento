export interface FollowUpWorkRun {
  stageId: string;
  agentProfileId: string;
  cliSessionId: string | null;
  executor: "server" | "runner";
}

/**
 * Who answers a follow-up on this card.
 *
 * Same stage as the last work run: resume that session, so the agent
 * keeps its context. A different stage (send-back, a drag back): the
 * pipeline agent for the stage the card is in, as a fresh run. The
 * previous agent's session is the wrong conversation now.
 */
export function followUpSource(input: {
  currentStageId: string | null;
  assignedAgentProfileId: string | null;
  lastWorkRun: FollowUpWorkRun;
}): FollowUpWorkRun {
  const { currentStageId, assignedAgentProfileId, lastWorkRun } = input;
  if (currentStageId && lastWorkRun.stageId !== currentStageId) {
    return {
      stageId: currentStageId,
      agentProfileId: assignedAgentProfileId ?? lastWorkRun.agentProfileId,
      cliSessionId: null,
      executor: lastWorkRun.executor,
    };
  }
  return lastWorkRun;
}
