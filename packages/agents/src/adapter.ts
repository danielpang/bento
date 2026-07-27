import type { AgentCli, AgentEvent, RunOutcome } from "@bento/core";

export interface BuildCommandInput {
  prompt: string;
  model: string;
  /** Working directory inside the sandbox. */
  cwd: string;
  resumeSessionId?: string;
  extraArgs?: string[];
}

/**
 * Maps one agent CLI onto the normalized run lifecycle.
 * Adapters never spawn processes themselves; the orchestrator runs the
 * command through a SandboxDriver and feeds stdout lines to parseEvent.
 */
/**
 * A live conversation with a working agent, over the process's stdin.
 *
 * Tools differ in what a mid-task message means, and the difference is
 * user-visible, so it is declared rather than papered over:
 * "steer" reaches the agent while it works (pi delivers after the
 * current tool call); "queue" waits for the current turn to finish
 * (Claude Code processes stdin messages sequentially). Tools without
 * this capability fall back to queue-and-resume between runs.
 */
export interface LiveSession {
  delivery: "steer" | "queue";
  /**
   * Whether this particular run should hold a live session. Absent
   * means always. The fake agent keys off the prompt so its scripted
   * one-shot behaviors (SLOW, FAIL) stay available to tests.
   */
  appliesTo?(input: BuildCommandInput): boolean;
  /** argv for a session that reads user messages on stdin. */
  buildCommand(input: BuildCommandInput): string[];
  /** One stdin line delivering the opening prompt or a follow-up. */
  encodeMessage(text: string, kind: "initial" | "followUp"): string;
}

export interface AgentAdapter {
  cli: AgentCli;
  /** Env var names that must be present in the sandbox for this CLI. */
  /** Credentials the agent cannot run without. */
  requiredEnv: string[];
  /**
   * Credentials forwarded when the organization has them. Base URL
   * overrides live here, which is how a provider gets routed through
   * OpenRouter without a separate adapter.
   */
  optionalEnv?: string[];
  /**
   * Env var names that stand in for every requiredEnv entry: a login
   * token where requiredEnv names an API key. Any one of these present
   * means the agent can start. Listed separately from optionalEnv
   * because presence changes whether a run is allowed to begin, not
   * just what gets forwarded.
   */
  authAlternatives?: string[];
  /**
   * Home relative paths holding this tool's own login, so a local user
   * can run agents on a subscription they already pay for instead of a
   * separate API key. Only ever mounted in local mode, and only when
   * explicitly enabled: these are long lived credentials, and an agent
   * can read anything its sandbox can.
   */
  configPaths?: string[];
  /**
   * Credentials required for a specific model, for provider agnostic
   * tools: an openrouter/ model needs the OpenRouter key even though
   * the tool as a whole requires nothing. Overrides requiredEnv when
   * present. Without this, a keyless opencode run started fine and
   * died inside the tool with a generic server error.
   */
  requiredEnvFor?(model: string): string[];
  /** Present when the tool can hold a live stdin conversation. */
  live?: LiveSession;
  buildCommand(input: BuildCommandInput): string[];
  /** Parse one stdout line. Return null for lines that are not events. */
  parseEvent(line: string): AgentEvent | null;
  /** Decide success/failure from the collected events and exit code. */
  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome;
}

export function lastResultEvent(events: AgentEvent[]): Extract<AgentEvent, { type: "result" }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.type === "result") return ev;
  }
  return undefined;
}

/** The key a provider/model string needs, for provider agnostic tools. */
export function providerKeyFor(model: string): string[] {
  const byProvider: Record<string, string> = {
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    gemini: "GEMINI_API_KEY",
  };
  const key = byProvider[model.split("/")[0] ?? ""];
  return key ? [key] : [];
}
