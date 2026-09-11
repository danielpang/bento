import type { Feature, Stage } from "@bento/api-client";

export function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "starting":
    case "queued":
      return "blue";
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "gated":
      return "yellow";
    default:
      return "gray";
  }
}

/**
 * What a card is doing, in one word: a working agent first, then where
 * the card stands, then its newest run. The run status has to be known
 * for every card and not just the selected one, or a board of working
 * agents reads as four idle cards and one that is doing something.
 *
 * A working agent outranks the gate for the same reason: a card stays
 * gated while an agent judges it or re-runs its stage, and reporting
 * only the gate hid every one of those agents. The wait line underneath
 * still says what the gate is holding out for.
 */
export function cardState(feature: Feature, runStatus: string | undefined): string {
  if (feature.status === "done") return "completed";
  if (feature.status === "cancelled") return "cancelled";
  if (runStatus === "queued" || runStatus === "starting" || runStatus === "running") return runStatus;
  if (feature.status === "gated") return "gated";
  if (!feature.currentStageId) return "backlog";
  return runStatus ?? "idle";
}

/** A card whose work is over: finished or abandoned, either way not moving. */
export function isFinished(feature: Pick<Feature, "status">): boolean {
  return feature.status === "done" || feature.status === "cancelled";
}

const inBacklog = (feature: Feature) => !feature.currentStageId && !isFinished(feature);
const inLane = (feature: Feature, stageId: string) =>
  feature.currentStageId === stageId && !isFinished(feature);

/**
 * Flattened order used for keyboard selection: backlog, then stages,
 * then completed. Finished cards keep the stage they ended in, so
 * leaving them in that lane would put the highlight on a shipped card
 * while j/k walked what looked like the review queue.
 */
export function orderFeatures(stages: Stage[], features: Feature[]): Feature[] {
  const backlog = features.filter(inBacklog);
  const staged = stages.flatMap((stage) => features.filter((f) => inLane(f, stage.id)));
  const finished = features.filter(isFinished);
  return [...backlog, ...staged, ...finished];
}
