import type { AgentEvent } from "@bento/core";

/**
 * What the composer's one Stop button does.
 *
 * On an agent that can be interrupted, Stop first stops the turn the
 * agent is working on, which keeps the session for the person's next
 * message; once the agent is waiting (its turn ended, by itself or by an
 * interrupt), Stop ends the run. Everywhere else Stop ends the run, as
 * it always did. So a second press after an interrupt is the way out.
 */
export type StopAction = "interrupt" | "end";

export function stopAction(canInterrupt: boolean, events: readonly AgentEvent[]): StopAction {
  return canInterrupt && turnRunning(events) ? "interrupt" : "end";
}

/**
 * Whether the agent is in a turn, read off the run's transcript: a turn
 * runs from a person's message (the prompt included) until its result.
 * With neither yet, the run is starting its first turn.
 */
export function turnRunning(events: readonly AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "result") return false;
    if (event.type === "message" && event.role === "user") return true;
  }
  return true;
}
