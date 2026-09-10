import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

/**
 * One JSONL envelope from `muse exec --json`. Every line carries a
 * `payload_type` naming the record, a `payload` with the body, and a
 * `stream` that identifies the session when `kind` is "session".
 *
 * Captured from Muse Code 1.1.1 (`muse exec --json --yolo --provider echo`).
 */
interface MuseLine {
  schema_version?: number;
  stream?: { kind?: string; id?: string };
  payload_type?: string;
  payload?: {
    text?: string;
    reason?: string;
    task_kind?: string;
  };
  correlation_facts?: {
    tool_name?: string;
  };
}

/**
 * Meta's Muse Code CLI (`muse`) in headless exec mode.
 *
 * The stream is JSONL with an outer envelope: every line names its
 * `payload_type`, and the body sits under `payload`. A session id rides
 * `stream` when `kind` is "session", so a resume has an id to pass to
 * `--session-id`. Token fragments arrive as `run.output.delta` and are
 * display-only; the finished answer is `run.terminal.completed`.
 *
 * `--yolo` is what makes a headless run possible at all: without it
 * every tool call waits for an approval nobody is there to give, and
 * Muse's own OS sandbox sits inside the container that is already the
 * boundary. `--user-input-auto-resolve` cancels `request_user_input`
 * the same way, so a prompt for a person cannot hang the process.
 *
 * Authentication is `META_API_KEY`. Muse Code can also sign in with a
 * browser, which no sandbox can do. Local mode can share this machine's
 * `~/.config/muse` the way the other tools share their logins.
 *
 * https://dev.meta.ai/docs/muse-code
 */
export const museAdapter: AgentAdapter = {
  cli: "muse",
  requiredEnv: ["META_API_KEY"],
  configPaths: [".config/muse"],

  /**
   * Muse reads MCP servers from settings.json rather than a flag, so
   * the whole file is Bento's to overwrite each run. The orchestrator
   * skips this adapter when local mode has the real ~/.config/muse
   * mounted read-only over it.
   */
  mcp: {
    renderConfig(servers) {
      const mcp_servers = Object.fromEntries(
        servers.map((s) => [
          s.slug,
          {
            transport: s.transport === "sse" ? "sse" : "streamable_http",
            url: s.url,
            headers: s.headers,
            enabled: true,
            mode: "optional",
          },
        ]),
      );
      return [
        {
          path: "/root/.config/muse/settings.json",
          content: JSON.stringify({ schema_version: 1, mcp_servers }, null, 2),
        },
      ];
    },
  },

  buildCommand(input: BuildCommandInput): string[] {
    const cmd = [
      "muse",
      "exec",
      "--json",
      // Our container is the boundary. Without this every tool call
      // waits for an approval nobody is there to give.
      "--yolo",
      "--user-input-auto-resolve",
      "--workspace",
      input.cwd,
      "--model",
      input.model,
    ];
    if (input.resumeSessionId) cmd.push("--session-id", input.resumeSessionId);
    if (input.extraArgs?.length) cmd.push(...input.extraArgs);
    cmd.push(input.prompt);
    return cmd;
  },

  /**
   * Token fragments of the answer being composed. The finished text
   * arrives as `run.terminal.completed` and becomes the transcript's
   * message, so forwarding it here as well would type the answer out
   * twice.
   */
  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    const parsed = parseLine(line);
    if (!parsed || parsed.payload_type !== "run.output.delta") return null;
    return { channel: "text", text: parsed.payload?.text ?? "" };
  },

  parseEvent(line: string): AgentEvent | null {
    const parsed = parseLine(line);
    if (!parsed) return null;
    const payloadType = parsed.payload_type ?? "";

    if (payloadType === "runtime.command.accepted" || payloadType === "run.lifecycle.started") {
      const ev: AgentEvent = { type: "init", raw: parsed };
      const sessionId = sessionIdOf(parsed);
      if (sessionId !== undefined) ev.sessionId = sessionId;
      return ev;
    }

    if (payloadType === "task.lifecycle.proposed") {
      const taskKind = parsed.payload?.task_kind ?? "";
      if (!taskKind.startsWith("tool.")) return null;
      const name = taskKind.slice("tool.".length) || "tool";
      return { type: "tool", name, phase: "start", raw: parsed };
    }

    if (payloadType === "tool.result") {
      return {
        type: "tool",
        name: parsed.correlation_facts?.tool_name ?? "tool",
        phase: "end",
        detail: parsed.payload?.text,
        raw: parsed,
      };
    }

    if (payloadType === "run.terminal.completed") {
      const text = parsed.payload?.text ?? "";
      if (!text) return null;
      return { type: "message", role: "assistant", text, raw: parsed };
    }

    if (payloadType.startsWith("run.terminal.")) {
      const ev: AgentEvent = { type: "result", ok: false, raw: parsed };
      const sessionId = sessionIdOf(parsed);
      if (sessionId !== undefined) ev.sessionId = sessionId;
      const reason = parsed.payload?.reason?.trim();
      if (reason) ev.error = reason;
      return ev;
    }

    return null;
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    const init = events.find((e) => e.type === "init");
    const sessionId = result?.sessionId ?? (init?.type === "init" ? init.sessionId : undefined);
    if (result && !result.ok) {
      const outcome: RunOutcome = { ok: false, error: result.error ?? `exit code ${exitCode}` };
      if (sessionId !== undefined) outcome.sessionId = sessionId;
      return outcome;
    }
    // Docs: 0 completed, 1 fail or cancelled, 2 usage error. A non-zero
    // exit is a failure whatever the stream claimed.
    if (exitCode !== 0) {
      const outcome: RunOutcome = {
        ok: false,
        error: `muse stopped before reporting a result (exit code ${exitCode})`,
      };
      if (sessionId !== undefined) outcome.sessionId = sessionId;
      return outcome;
    }
    const outcome: RunOutcome = { ok: true };
    if (sessionId !== undefined) outcome.sessionId = sessionId;
    return outcome;
  },
};

function parseLine(line: string): MuseLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as MuseLine;
  } catch {
    return null;
  }
}

function sessionIdOf(parsed: MuseLine): string | undefined {
  if (parsed.stream?.kind === "session" && parsed.stream.id) return parsed.stream.id;
  return undefined;
}
