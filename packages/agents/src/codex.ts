import type { AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; command?: string; status?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/**
 * OpenAI Codex CLI in non-interactive mode. Codex has its own sandbox,
 * which is redundant inside ours, so it runs with full access and our
 * container provides the boundary.
 */
export const codexAdapter: AgentAdapter = {
  cli: "codex",
  stdoutMode: "events",
  requiredEnv: ["OPENAI_API_KEY"],
  optionalEnv: ["OPENAI_BASE_URL"],
  configPaths: [".codex"],

  buildCommand(input: BuildCommandInput): string[] {
    const cmd = input.resumeSessionId
      ? ["codex", "exec", "resume", input.resumeSessionId, input.prompt]
      : ["codex", "exec", input.prompt];
    cmd.push(
      "--json",
      // Bypasses approvals AND Codex's own sandbox: our container is the
      // boundary. "--sandbox danger-full-access" would still prompt for
      // approvals, which deadlocks a headless run.
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--cd",
      input.cwd,
      "-m",
      input.model,
    );
    if (input.extraArgs?.length) cmd.push(...input.extraArgs);
    return cmd;
  },

  parseEvent(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: CodexLine;
    try {
      parsed = JSON.parse(trimmed) as CodexLine;
    } catch {
      return null;
    }

    switch (parsed.type) {
      case "thread.started": {
        const ev: AgentEvent = { type: "init", raw: parsed };
        if (parsed.thread_id !== undefined) ev.sessionId = parsed.thread_id;
        return ev;
      }
      case "item.completed": {
        const item = parsed.item;
        if (!item) return null;
        if (item.type === "assistant_message" || item.type === "agent_message") {
          return { type: "message", role: "assistant", text: item.text ?? "", raw: parsed };
        }
        if (item.type === "command_execution") {
          return { type: "tool", name: item.command ?? "command", phase: "end", detail: item.status, raw: parsed };
        }
        if (item.type === "file_change" || item.type === "patch_apply") {
          return { type: "tool", name: item.type, phase: "end", detail: item.status, raw: parsed };
        }
        return null;
      }
      case "turn.completed": {
        const ev: AgentEvent = { type: "result", ok: true, raw: parsed };
        if (parsed.thread_id !== undefined) ev.sessionId = parsed.thread_id;
        return ev;
      }
      case "turn.failed":
      case "error": {
        const ev: AgentEvent = { type: "result", ok: false, raw: parsed };
        if (parsed.thread_id !== undefined) ev.sessionId = parsed.thread_id;
        ev.error = parsed.error?.message ?? "turn failed";
        return ev;
      }
      default:
        return null;
    }
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    if (!result) return { ok: false, error: `no terminal event (exit code ${exitCode})` };
    // Codex may emit a session id only on thread.started; fall back to it.
    const init = events.find((e) => e.type === "init");
    const sessionId = result.sessionId ?? (init?.type === "init" ? init.sessionId : undefined);
    const outcome: RunOutcome = { ok: result.ok && exitCode === 0 };
    if (sessionId !== undefined) outcome.sessionId = sessionId;
    if (!outcome.ok) outcome.error = result.error ?? `exit code ${exitCode}`;
    return outcome;
  },
};
