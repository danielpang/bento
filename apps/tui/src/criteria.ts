import type { AgentProfile } from "@bento/api-client";

/**
 * What each requirement means in words.
 *
 * The same list the web console renders, so one stage does not read as
 * two different things depending on which client is open, and so a
 * criterion this build has never heard of still arrives as a sentence
 * rather than as its wire token.
 */
export const CRITERION_WORDS: Record<string, string> = {
  // Still rendered, because stages built before the manual/automatic
  // mode existed carry one, but never offered: the stage's mode says
  // this now, and adding it here would quietly override that.
  manual: "A person approves",
  run_succeeded: "The agent finished",
  agent_judge: "An agent verifies the work is complete",
  pr_comments_resolved: "No unresolved review comments",
  checks_pass: "GitHub checks pass",
  command: "A command succeeds",
};

/** The requirements a stage can be given here, in the order offered. */
export const CRITERION_KINDS = [
  { type: "run_succeeded", label: CRITERION_WORDS.run_succeeded! },
  { type: "command", label: CRITERION_WORDS.command! },
  { type: "checks_pass", label: CRITERION_WORDS.checks_pass! },
  { type: "pr_comments_resolved", label: CRITERION_WORDS.pr_comments_resolved! },
  { type: "agent_judge", label: CRITERION_WORDS.agent_judge! },
] as const;

/**
 * One line naming what a requirement checks. Takes the loose shape a
 * gate check reports as well as a stage's own criterion, because both
 * are shown to the same person in the same words.
 */
export function describeCriterion(
  criterion: { type: string; cmd?: string | undefined; agentProfileId?: string | undefined },
  profiles: AgentProfile[] = [],
): string {
  if (criterion.type === "command") return `${CRITERION_WORDS.command}: ${criterion.cmd}`;
  if (criterion.type === "agent_judge") {
    const judge = profiles.find((p) => p.id === criterion.agentProfileId);
    return judge ? `${judge.name} verifies the work is complete` : CRITERION_WORDS.agent_judge!;
  }
  // A criterion added by a newer server, or by the console: naming it
  // and saying where it can be edited beats printing a bare token.
  return CRITERION_WORDS[criterion.type] ?? `${criterion.type} (edit this requirement in the web console)`;
}
