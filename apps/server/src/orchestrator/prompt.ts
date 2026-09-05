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
  /** Workspace directory whose files are captured onto the card as artifacts. */
  artifactsDir?: string,
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
  if (stage.createPr) {
    if (stage.slug === "implementation") {
      lines.push(
        "Bento copies this write-up to the pull request description when the run publishes. Start with a markdown H1 (# Title) when you want a custom pull request title; the rest becomes the description.",
      );
    } else if (stage.slug === "code-review") {
      lines.push(
        "Bento posts this write-up as a comment on the pull request when the run publishes. Put your full review here rather than only in the transcript.",
      );
    }
  }
  if (repositories.length > 1) {
    // Said explicitly because the obvious reading of "commit your work"
    // in a workspace of several checkouts is to commit in one of them.
    lines.push(
      "Each repository is a separate checkout with its own history: a change touching two of them needs a commit in each.",
    );
  }
  /**
   * Where visual output goes. Outside the repositories on purpose: a
   * mockup is for the person reviewing the card, not for the pull
   * request, and files here are captured onto the card when the run
   * succeeds. Self-contained HTML because the card shows one file in a
   * sandboxed frame, with no way to fetch a stylesheet next to it.
   */
  if (artifactsDir) {
    lines.push(
      `If your work here produced something visual for people to review (a design mockup, an HTML preview, a screenshot, a diagram), save it under ${artifactsDir}. Files there are shown on the feature card. Keep each file self-contained: one HTML file with its styles, scripts, and images inlined; PNG, JPEG, or WebP images; Mermaid diagrams as .mmd files; or Markdown. Do not commit these files.`,
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

export interface ConflictedPullRequest {
  /** The repository's display name, "acme/api" when it left the project. */
  name: string;
  number: number;
  defaultBranch: string;
}

export interface RebaseTarget {
  name: string;
  defaultBranch: string;
}

export interface FailingPullRequestChecks {
  name: string;
  number: number;
  url: string;
}

/**
 * What a resolve-conflicts run asks its agent to do. Lives here with
 * the other prompt builders because it encodes sandbox and publishing
 * invariants the route layer does not own: what origin/<base> holds
 * when the run starts, and that the server, not the agent, pushes.
 *
 * The agent is told not to push because it cannot and must not: the
 * push credential stays on the server, which force pushes with lease
 * protection when the run finishes.
 */
export function buildConflictResolutionPrompt(branch: string, conflicted: ConflictedPullRequest[]): string {
  // Distinct bases as separate refspecs: git fetch takes several, and
  // prose joiners ("and") would be parsed as a ref and fail the fetch.
  const bases = [...new Set(conflicted.map((pr) => pr.defaultBranch))];
  return [
    "GitHub reports merge conflicts on this card's pull requests:",
    ...conflicted.map(
      (pr) =>
        `- ${pr.name}: pull request #${pr.number} cannot merge because branch ${branch} conflicts with ${pr.defaultBranch}.`,
    ),
    "",
    "In each repository named above, rebase the feature branch onto the newest base branch commit and resolve every conflict:",
    `1. Bring the base branch up to date: git fetch origin ${bases.join(" ")}. If the fetch fails (this sandbox may have no credentials for the remote), continue with origin/<base branch> as it is and say so in your summary; it may be behind the real base branch.`,
    `2. On branch ${branch}, run: git rebase origin/<base branch>.`,
    "3. Resolve each conflict so the result keeps both the base branch's changes and this card's intent. Read the surrounding code rather than picking a side mechanically.",
    "4. Stage each resolved file and run git rebase --continue until the rebase completes. If the project has a quick build or test command, run it to confirm the resolution holds together.",
    "5. Do not push and do not open pull requests. The server force pushes the rebased branch with lease protection when this run finishes, which updates the existing pull requests.",
  ].join("\n");
}

/**
 * Rebase prompt for cards that cannot publish because the feature
 * branch is not based on the current default branch tip.
 */
/**
 * What a fix-CI run asks its agent to do. Like conflict resolution,
 * the agent commits and the server publishes; it never receives push
 * credentials.
 */
export function buildCiFixPrompt(failing: FailingPullRequestChecks[]): string {
  return [
    "GitHub reports failing CI checks on this card's pull requests:",
    ...failing.map((pr) => `- ${pr.name}: pull request #${pr.number} (${pr.url})`),
    "",
    "Fix the failing checks with the smallest change that makes CI pass:",
    "1. Read the check output on GitHub, or run the same commands locally in the repository.",
    "2. Fix every failure. Run the repository's test command before you finish.",
    "3. Commit your fixes with a descriptive message.",
    "4. Do not push and do not open pull requests. The server publishes the branch when this run finishes.",
  ].join("\n");
}

export function buildRebaseForPublishPrompt(branch: string, targets: RebaseTarget[]): string {
  const bases = [...new Set(targets.map((t) => t.defaultBranch))];
  return [
    "This card's branch is behind the base branch and cannot be published until it is rebased.",
    ...targets.map((t) => `- ${t.name}: rebase onto ${t.defaultBranch}.`),
    "",
    "In each repository named above, rebase the feature branch onto the newest base branch commit and resolve any conflicts:",
    `1. Bring the base branch up to date: git fetch origin ${bases.join(" ")}. If the fetch fails (this sandbox may have no credentials for the remote), continue with origin/<base branch> as it is and say so in your summary.`,
    `2. On branch ${branch}, run: git rebase origin/<base branch>.`,
    "3. Resolve each conflict so the result keeps both the base branch's changes and this card's intent. Read the surrounding code rather than picking a side mechanically.",
    "4. Stage each resolved file and run git rebase --continue until the rebase completes. If the project has a quick build or test command, run it to confirm the resolution holds together.",
    "5. Do not push and do not open pull requests. The server publishes the branch when this run finishes.",
  ].join("\n");
}
