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
