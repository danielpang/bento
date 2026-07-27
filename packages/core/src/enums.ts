import { z } from "zod";

export const agentCli = z.enum(["claude-code", "codex", "cursor", "opencode", "pi", "fake"]);
export type AgentCli = z.infer<typeof agentCli>;

export const featureStatus = z.enum(["backlog", "active", "gated", "done", "cancelled"]);
export type FeatureStatus = z.infer<typeof featureStatus>;

export const runStatus = z.enum(["queued", "starting", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatus>;

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
