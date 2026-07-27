import { stageArtifactPath } from "@bento/core";
import type { features, stages } from "@bento/db";

type Feature = typeof features.$inferSelect;
type Stage = typeof stages.$inferSelect;

/**
 * Builds the prompt an agent receives for one stage run. Prior stage
 * output lives in committed artifact files in the worktree, which is how
 * context flows between stages (and between different agent CLIs).
 */
export function buildStagePrompt(
  feature: Feature,
  stage: Stage,
  allStages: Stage[],
  repositories: { name: string; mountPath: string; testCommand?: string | null }[] = [],
  agent?: { name: string; skill: string | null },
): string {
  const artifact = stageArtifactPath(stage.slug);
  const priorStages = allStages.filter((s) => s.position < stage.position);
  const priorArtifacts = priorStages.map((s) => stageArtifactPath(s.slug));

  const lines = [
    agent
      ? `You are "${agent.name}", working on the feature "${feature.title}" during the "${stage.name}" stage of a product development pipeline.`
      : `You are working on the feature "${feature.title}" during the "${stage.name}" stage of a product development pipeline.`,
    "",
    `Feature description: ${feature.description || "(none provided)"}`,
    "",
    `Stage goal: ${stage.description}`,
    "",
  ];
  /**
   * The user-authored skill: how this agent works and, above all, what
   * its stage write-up must contain. It sits before the mechanics so it
   * reads as the role, and after the goal so it cannot override what
   * the stage is for.
   */
  if (agent?.skill?.trim()) {
    lines.push("Your operating instructions, defined by your team:", agent.skill.trim(), "");
  }
  if (repositories.length > 0) {
    lines.push(
      repositories.length === 1
        ? `The repository is checked out at ${repositories[0]!.mountPath}.`
        : "This project spans several repositories, each checked out on the same branch:",
      ...(repositories.length === 1 ? [] : repositories.map((r) => `- ${r.name} at ${r.mountPath}`)),
      "",
    );
  }
  /**
   * How this project proves its own work. Given to the agent rather
   * than run by the server on purpose: an agent that sees the failures
   * while it is still working can fix them, and a check that only runs
   * afterwards arrives when nobody is left to act on it.
   */
  const checked = repositories.filter((repo) => repo.testCommand?.trim());
  if (checked.length > 0) {
    lines.push(
      checked.length === 1 && repositories.length === 1
        ? `Check your work by running: ${checked[0]!.testCommand!.trim()}`
        : "Check your work in each repository you changed, by running:",
      ...(checked.length === 1 && repositories.length === 1
        ? []
        : checked.map((repo) => `- in ${repo.mountPath}: ${repo.testCommand!.trim()}`)),
      "It must pass before you finish. If it cannot pass, say so in your summary and explain why, rather than leaving it broken quietly.",
      "",
    );
  }
  if (priorArtifacts.length > 0) {
    lines.push(
      "Earlier stages committed their output to these files; read the ones that exist before starting:",
      ...priorArtifacts.map((p) => `- ${p}`),
      "",
    );
  }
  const artifactRepo = repositories[0];
  const artifactPath = artifactRepo ? `${artifactRepo.mountPath}/${artifact}` : artifact;
  lines.push(
    `When you finish, write a concise summary of your work for this stage to ${artifactPath} and commit all changes (including that file) with a descriptive commit message${
      repositories.length > 1 ? " in every repository you changed" : ""
    }.`,
  );
  if (repositories.length > 1) {
    // Said explicitly because the obvious reading of "commit your work"
    // in a workspace of several checkouts is to commit in one of them.
    lines.push(
      "Each repository is a separate checkout with its own history: a change touching two of them needs a commit in each.",
    );
  }
  /**
   * The one hard rule. Work reaches the trunk through a pull request
   * and a person; a stage of a pipeline is neither. An agent that
   * merges its own work has skipped every remaining stage and every
   * gate, which is the whole point of the board.
   *
   * Stated as a prohibition rather than left implied: an agent asked to
   * "ship this" will otherwise reach for the merge, and the request
   * reads as reasonable in isolation.
   */
  lines.push(
    "Stay on your branch. Never merge into main or master, never commit to them directly, and never push to them, whatever the task appears to ask for. Pushing your own branch is fine; Bento also pushes it and opens a pull request for each repository you committed in once this run finishes.",
  );
  return lines.join("\n");
}
