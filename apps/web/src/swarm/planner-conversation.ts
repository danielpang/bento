import type { RecordedRunEvent } from "@bento/core";
import type { SwarmPlannerMessage } from "./client.js";
import type { SwarmPlannerHistoryRun } from "./types.js";

/** Delivery can be rebound on a retry; the time a person spoke cannot. */
export function plannerMessageRun(
  message: SwarmPlannerMessage,
  runs: SwarmPlannerHistoryRun[] | undefined,
  latestRunId: string,
): string {
  if (!runs?.length) return message.runId ?? latestRunId;
  const createdAt = Date.parse(message.createdAt);
  const original = runs.find((run, index) => {
    // Older terminal rows can lack endedAt. The next run still bounds them.
    const end = run.endedAt ?? runs[index + 1]?.queuedAt;
    return !end || createdAt <= Date.parse(end);
  });
  return original?.id ?? latestRunId;
}

/**
 * Message rows are the person's words, keyed by id. User events on a
 * planner are generated wake envelopes, including worker reports and
 * instructions, not additional messages from the person. Replace them
 * with the persisted message rows rather than deduplicating by text.
 */
export function plannerConversationEvents(events: RecordedRunEvent[], messages: SwarmPlannerMessage[]): {
  events: RecordedRunEvent[];
  messages: SwarmPlannerMessage[];
} {
  const ordered = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const merged: RecordedRunEvent[] = [];
  let next = 0;
  const appendMessage = () => {
    const message = ordered[next++]!;
    merged.push({ type: "message", role: "user", text: message.text, recordedAt: message.createdAt });
  };
  for (const event of events) {
    while (next < ordered.length && (event.recordedAt
      ? Date.parse(ordered[next]!.createdAt) <= Date.parse(event.recordedAt)
      : ordered[next]!.status !== "queued")) appendMessage();
    if (event.type !== "message" || event.role !== "user") merged.push(event);
  }
  while (next < ordered.length) appendMessage();
  return { events: merged, messages: ordered };
}
