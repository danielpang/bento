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
    numTurns: z.number().int().optional(),
    error: z.string().optional(),
    raw: z.unknown().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof agentEvent>;

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

export interface RunOutcome {
  ok: boolean;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  error?: string;
}
