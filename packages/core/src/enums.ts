import { z } from "zod";

export const agentCli = z.enum([
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "pool",
  "dsh",
  "antigravity",
  "fake",
]);
export type AgentCli = z.infer<typeof agentCli>;

export const featureStatus = z.enum(["backlog", "active", "gated", "done", "cancelled"]);
export type FeatureStatus = z.infer<typeof featureStatus>;

export const runStatus = z.enum(["queued", "starting", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatus>;

/** A run that has stopped. In-flight work has not printed a cost yet. */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

/**
 * Whether a run belongs on a spend rollup.
 *
 * Judges are the gate talking to itself, and a run that is still
 * queued or working has not printed a figure. Sessions already drops
 * both; spend has to, or a Claude card wears "$4.20+" after a silent
 * judge, and the topbar chip grows a plus while an agent is still
 * running.
 */
export function isSpendRun(run: { status: string; kind?: string | null }): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status) && run.kind !== "judge";
}

export const sandboxProvider = z.enum(["docker", "sprite"]);
export type SandboxProvider = z.infer<typeof sandboxProvider>;

export const sandboxStatus = z.enum(["provisioning", "ready", "busy", "hibernated", "destroyed"]);
export type SandboxStatus = z.infer<typeof sandboxStatus>;

export const gateType = z.enum(["manual", "auto"]);
export type GateType = z.infer<typeof gateType>;

export const transitionTrigger = z.enum(["manual", "gate_auto"]);
export type TransitionTrigger = z.infer<typeof transitionTrigger>;

export const gateCheckStatus = z.enum(["pending", "passed", "failed"]);
export type GateCheckStatus = z.infer<typeof gateCheckStatus>;
