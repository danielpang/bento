import type { AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

interface CursorLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  chat_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  message?: { role?: string; content?: { type?: string; text?: string; name?: string }[] };
  /** Discriminated by tool name: { readToolCall: {...} }, { shellToolCall: {...} }, ... */
  tool_call?: Record<string, unknown>;
  call_id?: string;
}

/**
 * Cursor CLI headless mode. Its stream-json output resembles Claude
 * Code's, with two differences: the session id may appear as session_id
 * or chat_id, and tool calls are a wrapper object keyed by tool name
 * rather than carrying a flat "name" field.
 */
export const cursorAdapter: AgentAdapter = {
  cli: "cursor",
  requiredEnv: ["CURSOR_API_KEY"],
  configPaths: [".cursor"],

  // cursor-agent reads the global ~/.cursor/mcp.json; the sandbox's
  // home is Bento's to write, and the orchestrator skips this adapter
  // when local mode has the real ~/.cursor mounted read-only over it.
  mcp: {
    renderConfig(servers) {
      const mcpServers = Object.fromEntries(
        servers.map((s) => [s.slug, { url: s.url, headers: s.headers }]),
      );
      return [{ path: "/root/.cursor/mcp.json", content: JSON.stringify({ mcpServers }, null, 2) }];
    },
  },

  buildCommand(input: BuildCommandInput): string[] {
    const cmd = [
      "cursor-agent",
      "-p",
      "--output-format",
      "stream-json",
      // Our container is the boundary: allow everything, disable
      // Cursor's sandbox, and trust the workspace (--trust needs -p).
      "--force",
      "--sandbox",
      "disabled",
      "--trust",
      "--workspace",
      input.cwd,
      "--model",
      input.model,
    ];
    if (input.resumeSessionId) cmd.push("--resume", input.resumeSessionId);
    if (input.extraArgs?.length) cmd.push(...input.extraArgs);
    cmd.push(input.prompt);
    return cmd;
  },

  parseEvent(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: CursorLine;
    try {
      parsed = JSON.parse(trimmed) as CursorLine;
    } catch {
      return null;
    }
    const sessionId = parsed.session_id ?? parsed.chat_id;

    if (parsed.type === "system" || parsed.type === "session" || parsed.subtype === "init") {
      const ev: AgentEvent = { type: "init", raw: parsed };
      if (sessionId !== undefined) ev.sessionId = sessionId;
      if (parsed.model !== undefined) ev.model = parsed.model;
      return ev;
    }

    if (parsed.type === "tool_call" || parsed.type === "tool_use") {
      // The tool name is the single key of the wrapper object, e.g.
      // { readToolCall: { args, result } } -> "readToolCall".
      const name = parsed.tool_call ? (Object.keys(parsed.tool_call)[0] ?? "tool") : "tool";
      return {
        type: "tool",
        name,
        phase: parsed.subtype === "started" ? "start" : "end",
        detail: parsed.call_id,
        raw: parsed,
      };
    }

    if (parsed.type === "assistant" || parsed.type === "user") {
      const blocks = parsed.message?.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text ?? "")
        .join("\n");
      if (!text) return null;
      return { type: "message", role: parsed.type === "assistant" ? "assistant" : "user", text, raw: parsed };
    }

    if (parsed.type === "result") {
      const ev: AgentEvent = { type: "result", ok: parsed.is_error !== true, raw: parsed };
      if (sessionId !== undefined) ev.sessionId = sessionId;
      if (parsed.is_error && parsed.result !== undefined) ev.error = parsed.result;
      return ev;
    }

    return null;
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    // Cursor's headless exit codes are undocumented, so the terminal
    // result event is authoritative here; a missing one is a failure.
    if (!result) return { ok: false, error: `Cursor stopped before reporting a result (exit code ${exitCode})` };
    const init = events.find((e) => e.type === "init");
    const sessionId = result.sessionId ?? (init?.type === "init" ? init.sessionId : undefined);
    const outcome: RunOutcome = { ok: result.ok };
    if (sessionId !== undefined) outcome.sessionId = sessionId;
    if (!outcome.ok) outcome.error = result.error ?? `exit code ${exitCode}`;
    return outcome;
  },
};
