/** Short, actionable labels for failures whose raw logs belong in a drawer. */
export function plannerFailure(error: string | null): { title: string; summary: string; beforeAgent: boolean } {
  if (error && /sandbox provisioning failed|repository path .* does not exist|fatal: not a git repository/i.test(error)) {
    return {
      title: "Could not start",
      summary: "Repository checkout could not be prepared.",
      beforeAgent: true,
    };
  }
  return { title: "Stopped", summary: "The planner stopped before finishing the plan.", beforeAgent: false };
}

export const MERGE_QUEUE_FAILURE = "merge queue failure, see agent worker for more details";

/**
 * Why a merge queue landing failed, in a sentence, keyed by the code
 * the server records with it. The server's own words stay in the
 * drawer's technical details; this is what a person reads first.
 */
export const LANDING_FAILURE_WORDS: Record<string, string> = {
  no_repositories: "This project has no repositories, so there is nothing to land.",
  driver_unavailable: "This server has no sandbox driver for the machine holding this branch.",
  checkout_failed: "The swarm's checkout could not be prepared to take this branch.",
  swarm_sandbox_gone: "The swarm's sandbox is gone, so there is no swarm branch here to land this onto.",
  task_sandbox_gone: "This task's sandbox is gone, and its branch was not on GitHub to read back.",
  transfer_unsupported: "This sandbox driver cannot move a branch between sandboxes.",
  wake_failed: "The sandbox holding this branch could not be started.",
  attempts_exhausted: "The swarm's branch kept moving or refusing this branch, five attempts in a row.",
  conflict_unresolved: "This branch conflicts with the swarm's, and the resolver could not settle it.",
  checks_failed: "This branch landed, and the swarm's checks then failed on it.",
  checks_unavailable: "The swarm's checks could not run, so this branch was not accepted.",
  landing_error: "Git could not land this branch.",
};

/** The sentence for a landing failure code, or null for one this console does not know. */
export function landingFailureWords(code: unknown): string | null {
  return typeof code === "string" ? (LANDING_FAILURE_WORDS[code] ?? null) : null;
}
