import { z } from "zod";

/**
 * Normalized agent event. Every adapter maps its CLI's native stream
 * (Claude Code NDJSON, Codex ThreadEvents, Cursor stream-json, opencode SSE)
 * into this shape before it is persisted to run_events.
 */
export const agentEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    sessionId: z.string().optional(),
    model: z.string().optional(),
    raw: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("message"),
    role: z.enum(["assistant", "user", "system"]),
    text: z.string(),
    /**
     * A status line for a step that is under way ("Starting sandbox.",
     * "Installing tools."), which the next one replaces on screen. The
     * transcript keeps every one of them, in order: a restart and the
     * stall reaper read what the last step was. Only how a console
     * draws them changes; see `foldProgress`.
     */
    progress: z.boolean().optional(),
    raw: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    phase: z.enum(["start", "end"]),
    detail: z.unknown().optional(),
    raw: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("result"),
    ok: z.boolean(),
    sessionId: z.string().optional(),
    costUsd: z.number().optional(),
    /**
     * What the tool counted, for the tools that count tokens instead
     * of dollars. Codex prints these and no cost at all, which is the
     * whole reason a run can be priced rather than guessed at.
     */
    inputTokens: z.number().int().optional(),
    outputTokens: z.number().int().optional(),
    numTurns: z.number().int().optional(),
    error: z.string().optional(),
    /**
     * The turn ended because a person interrupted it, not because the
     * agent finished or failed. The session is still open: the person
     * is about to say what they want instead.
     */
    interrupted: z.boolean().optional(),
    raw: z.unknown().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof agentEvent>;

/**
 * A run's events as a console draws them: a run of progress lines is
 * one line, the latest. A boot that went through four steps reads
 * "Agent started." rather than four rows, and while it is under way the
 * one row changes in place.
 *
 * Only a progress line directly followed by another is dropped.
 * Anything between them (a retry notice, a warning, the agent's first
 * word) is a reason the earlier line still matters, so it stays where
 * it was. Pure, so history and the live stream fold the same way.
 */
export function foldProgress<T extends AgentEvent>(events: readonly T[]): T[] {
  const isProgress = (event: T | undefined): boolean =>
    event !== undefined && event.type === "message" && event.progress === true;
  return events.filter((event, index) => !(isProgress(event) && isProgress(events[index + 1])));
}

/** A transcript read includes the database's timestamp, not the agent's clock. */
export type RecordedRunEvent = AgentEvent & { recordedAt?: string };

/**
 * A token-sized slice of what the agent is composing right now.
 *
 * Ephemeral on purpose: deltas travel process, bus, SSE, screen and
 * are never persisted. The transcript's authoritative text arrives as
 * a "message" event when the message finishes; a run_events row per
 * token would bury it. That is also why this is a plain type rather
 * than part of the agentEvent schema: nothing stored ever validates
 * against it.
 *
 * "thinking" is separate from "text" because clients show them
 * differently: text is a draft of the message being written, thinking
 * is only a sign of life.
 */
export interface AgentDelta {
  channel: "text" | "thinking";
  text: string;
  /**
   * Characters of this channel's current message that streamed before
   * this fragment. A viewer that subscribed mid message receives a
   * fragment whose offset exceeds what it has, and can tell it is
   * holding a torn draft rather than rendering a sentence that starts
   * in the middle. Resets to zero with each new message.
   */
  offset: number;
}

/**
 * Whether a live run's agent is in a turn or waiting for a message,
 * as the server holding the run sees it. Bus only, like a delta: the
 * holder announces each change, and a viewer that knows nothing yet
 * reads it off the transcript instead.
 */
export type TurnState = "working" | "waiting";

export interface RunOutcome {
  ok: boolean;
  sessionId?: string;
  costUsd?: number;
  /**
   * Tokens in and out, when the tool reports those rather than a
   * price. Kept beside costUsd rather than converted here, because
   * turning tokens into dollars needs a rate card and an adapter has
   * no business holding one: the ledger prices them from the model
   * catalog and records the rate it used.
   */
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  error?: string;
}
