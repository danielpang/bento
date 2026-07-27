import type { AgentEvent, RunOutcome } from "@bento/core";
import { providerKeyFor, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

interface OpencodePart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string };
}

interface OpencodeLine {
  type?: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpencodePart;
  error?: unknown;
}

/**
 * opencode one-shot run with NDJSON output.
 *
 * Two quirks shape this adapter: opencode emits no session-start and no
 * terminal event (the stream simply ends when the session goes idle),
 * and the session id rides on every line. So success is "no error line
 * and exit code 0", and the session id is taken from whichever line
 * arrives first.
 *
 * Model ids are provider qualified, e.g. "anthropic/claude-sonnet-5".
 */
export const opencodeAdapter: AgentAdapter = {
  cli: "opencode",
  // Auth is provider specific rather than opencode specific; the
  // orchestrator forwards whichever provider keys are configured.
  // Provider agnostic: whichever of these the organization has stored
  // is forwarded, and the model string decides which one gets used.
  requiredEnv: [],
  requiredEnvFor: providerKeyFor,
  optionalEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"],
  configPaths: [".config/opencode", ".local/share/opencode"],

  buildCommand(input: BuildCommandInput): string[] {
    const cmd = [
      "opencode",
      "run",
      "--format",
      "json",
      // The real reason for a failure often only appears in opencode's
      // own log; printed to stderr it reaches the run's error tail.
      "--print-logs",
      // Auto-approve permissions. opencode has no OS sandbox to disable;
      // isolation comes from our container.
      "--auto",
      "--dir",
      input.cwd,
      "-m",
      input.model,
    ];
    if (input.resumeSessionId) cmd.push("--session", input.resumeSessionId);
    if (input.extraArgs?.length) cmd.push(...input.extraArgs);
    cmd.push(input.prompt);
    return cmd;
  },

  parseEvent(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: OpencodeLine;
    try {
      parsed = JSON.parse(trimmed) as OpencodeLine;
    } catch {
      return null;
    }

    switch (parsed.type) {
      case "text": {
        const text = parsed.part?.text ?? "";
        if (!text) return null;
        return { type: "message", role: "assistant", text, raw: parsed };
      }
      case "reasoning": {
        const text = parsed.part?.text ?? "";
        if (!text) return null;
        return { type: "message", role: "system", text, raw: parsed };
      }
      case "tool_use": {
        const status = parsed.part?.state?.status;
        return {
          type: "tool",
          name: parsed.part?.tool ?? "tool",
          phase: status === "running" ? "start" : "end",
          detail: status,
          raw: parsed,
        };
      }
      case "step_start": {
        const ev: AgentEvent = { type: "init", raw: parsed };
        if (parsed.sessionID !== undefined) ev.sessionId = parsed.sessionID;
        return ev;
      }
      case "error": {
        return { type: "result", ok: false, error: describeError(parsed.error), raw: parsed };
      }
      default:
        return null;
    }
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const failure = events.find((e) => e.type === "result" && !e.ok);
    const init = events.find((e) => e.type === "init");
    const sessionId = init?.type === "init" ? init.sessionId : undefined;

    if (failure && failure.type === "result") {
      const outcome: RunOutcome = { ok: false, error: failure.error ?? `exit code ${exitCode}` };
      if (sessionId !== undefined) outcome.sessionId = sessionId;
      return outcome;
    }
    const outcome: RunOutcome = { ok: exitCode === 0 };
    if (sessionId !== undefined) outcome.sessionId = sessionId;
    if (!outcome.ok) outcome.error = `exit code ${exitCode}`;
    return outcome;
  },
};

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as { name?: string; message?: string; data?: { message?: string } };
    return record.message ?? record.data?.message ?? record.name ?? JSON.stringify(error);
  }
  return "opencode error";
}
