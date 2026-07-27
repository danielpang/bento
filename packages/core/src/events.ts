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

export interface RunOutcome {
  ok: boolean;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  error?: string;
}
