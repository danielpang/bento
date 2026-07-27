import type { AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface ClaudeLine {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  message?: { role?: string; content?: ClaudeContentBlock[] };
}

/**
 * Runs Claude Code headlessly with stream-json output.
 * Permission checks are skipped because the sandbox is the security
 * boundary; never run this command outside a sandbox.
 */
export const claudeCodeAdapter: AgentAdapter = {
  cli: "claude-code",
  requiredEnv: ["ANTHROPIC_API_KEY"],
  optionalEnv: ["ANTHROPIC_BASE_URL"],
  // A subscription login token works in place of an API key. It is how
  // a server that cannot reach this machine's keychain (a container,
  // another host) still runs on the subscription: claude setup-token
  // mints one, and it travels as an env var or a stored secret.
  authAlternatives: ["CLAUDE_CODE_OAUTH_TOKEN"],
  configPaths: [".claude", ".claude.json"],

  buildCommand(input: BuildCommandInput): string[] {
    return ["claude", "-p", input.prompt, ...sharedFlags(input)];
  },

  /**
   * The live session: stdin stays open and each JSON line is a user
   * turn. Messages sent while a turn runs queue behind it; Claude Code
   * has no mid-turn steering primitive on this protocol.
   */
  live: {
    delivery: "queue",
    buildCommand(input: BuildCommandInput): string[] {
      // No positional prompt: with stream-json input, the opening
      // prompt arrives as the first stdin message like any other.
      return ["claude", "-p", "--input-format", "stream-json", ...sharedFlags(input)];
    },
    encodeMessage(text: string): string {
      return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    },
  },

  parseEvent(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(trimmed) as ClaudeLine;
    } catch {
      return null;
    }

    if (parsed.type === "system" && parsed.subtype === "init") {
      const ev: AgentEvent = { type: "init", raw: parsed };
      if (parsed.session_id !== undefined) ev.sessionId = parsed.session_id;
      if (parsed.model !== undefined) ev.model = parsed.model;
      return ev;
    }

    if (parsed.type === "assistant" || parsed.type === "user") {
      const blocks = parsed.message?.content ?? [];
      const toolUse = blocks.find((b) => b.type === "tool_use");
      if (toolUse) {
        return {
          type: "tool",
          name: toolUse.name ?? "unknown",
          phase: "start",
          detail: toolUse.input,
          raw: parsed,
        };
      }
      const toolResult = blocks.find((b) => b.type === "tool_result");
      if (toolResult) {
        return { type: "tool", name: "tool_result", phase: "end", detail: toolResult.content, raw: parsed };
      }
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      if (text) {
        return { type: "message", role: parsed.type === "assistant" ? "assistant" : "user", text, raw: parsed };
      }
      return null;
    }

    if (parsed.type === "result") {
      const ev: AgentEvent = { type: "result", ok: parsed.is_error === false, raw: parsed };
      if (parsed.session_id !== undefined) ev.sessionId = parsed.session_id;
      if (parsed.total_cost_usd !== undefined) ev.costUsd = parsed.total_cost_usd;
      if (parsed.num_turns !== undefined) ev.numTurns = parsed.num_turns;
      if (parsed.is_error && parsed.result !== undefined) ev.error = parsed.result;
      return ev;
    }

    return null;
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    if (!result) {
      return { ok: false, error: `Claude Code stopped before reporting a result (exit code ${exitCode})` };
    }
    const outcome: RunOutcome = { ok: result.ok && exitCode === 0 };
    if (result.sessionId !== undefined) outcome.sessionId = result.sessionId;
    if (result.costUsd !== undefined) outcome.costUsd = result.costUsd;
    if (result.numTurns !== undefined) outcome.numTurns = result.numTurns;
    if (!outcome.ok) outcome.error = result.error ?? `exit code ${exitCode}`;
    return outcome;
  },
};

/** The flags every claude invocation shares, live or one-shot. */
function sharedFlags(input: BuildCommandInput): string[] {
  const flags = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model",
    input.model,
  ];
  if (input.resumeSessionId) flags.push("--resume", input.resumeSessionId);
  if (input.extraArgs?.length) flags.push(...input.extraArgs);
  return flags;
}
