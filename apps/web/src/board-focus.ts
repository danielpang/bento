import type { Feature } from "@bento/api-client";

export type WorkGroup = "needs-you" | "running" | "ready" | "completed";
export type BoardFocus = "all" | "needs-you" | "running";

/** A running agent owns the next step, even while its card is gated. */
export function workGroup(feature: Feature, runStatus?: string): WorkGroup {
  if (feature.status === "done" || feature.status === "cancelled") return "completed";
  if (["queued", "starting", "running"].includes(runStatus ?? "")) return "running";
  if (feature.status === "gated" || runStatus === "failed" || runStatus === "cancelled") return "needs-you";
  return "ready";
}

export function readBoardFocus(value: string | null): BoardFocus {
  return value === "needs-you" || value === "running" ? value : "all";
}

export function attentionLabel(feature: Feature, runStatus: string | undefined, manual: boolean): string | undefined {
  if (workGroup(feature, runStatus) !== "needs-you") return undefined;
  if (runStatus === "failed") return "Run needs attention";
  if (runStatus === "cancelled") return "Agent stopped";
  return manual ? "Ready for your review" : "Requirements need attention";
}
