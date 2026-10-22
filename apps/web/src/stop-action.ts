import type { AgentEvent, TurnState } from "@bento/core";

/**
 * What the composer's one Stop button does.
 *
 * On an agent that can be interrupted, Stop only ever stops the turn the
 * agent is working on: the run stays open, and the agent waits for the
 * person's next message. With no turn running (the agent is already
 * waiting) there is nothing to stop, so the button rests. Everywhere
 * else Stop ends the run, as it always did.
 */
export type StopAction = "interrupt" | "end" | "none";

export function stopAction(canInterrupt: boolean, events: readonly AgentEvent[], turn: TurnState | null = null): StopAction {
  if (!canInterrupt) return "end";
  return turnRunning(events, turn) ? "interrupt" : "none";
}

/**
 * Whether the agent is in a turn. The server holding the run says so
 * when it changes (`turn`), and that is the answer whenever this viewer
 * has heard it: the transcript cannot tell, because Claude Code ends a
 * turn and then takes what was sent during it as one more, so a result
 * after a person's message is not always the end of the work.
 *
 * Before the server has said anything (a run on a server from before
 * this, or a stream that just opened), it is read off the transcript: a
 * turn runs from a person's message (the prompt included) until its
 * result. With neither yet, the run is starting its first turn.
 */
export function turnRunning(events: readonly AgentEvent[], turn: TurnState | null = null): boolean {
  if (turn) return turn === "working";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "result") return false;
    if (event.type === "message" && event.role === "user") return true;
  }
  return true;
}
