import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

/** The payload a step_update line carries, one step of the agent loop. */
interface AntigravityStep {
  conversation_id?: string;
  step_index?: number;
  /** ACTIVE while the step runs, DONE when it finishes. */
  state?: string;
  /** Closed vocabulary: user_input, agent_response, tool, checkpoint. */
  step_type?: string;
  /** A fragment of the message being composed, on agent_response steps. */
  text_delta?: string;
  /** The finished text, where a step carries one. */
  text?: string;
  tool_info?: {
    name?: string;
    parameters?: unknown;
    output?: unknown;
    error?: { type?: string; message?: string };
  };
  subagent_info?: {
    subagents?: { type_name?: string; role?: string; conversation_id?: string; log_uri?: string }[];
  };
}

/** The terminal result, as the json envelope and the stream both shape it. */
interface AntigravityResult {
  conversation_id?: string;
  /** SUCCESS on a run that produced a response; the failure's name otherwise. */
  status?: string;
  response?: string;
  error?: unknown;
  duration_seconds?: number;
  num_turns?: number;
  /** Tool actions the agent was refused, named rather than silently skipped. */
  denied_actions?: unknown[];
}

interface AntigravityLine {
  /** init, step_update or result; the payload sits under the same key. */
  event?: string;
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[]; permission_mode?: string; model?: string; agent?: string };
  step_update?: AntigravityStep;
  result?: AntigravityResult;
}

/**
 * Google's Antigravity CLI (`agy`) in headless print mode.
 *
 * Its stream is NDJSON with an outer envelope: every line carries an
 * `event` naming the payload, and the payload sits under a key of the
 * same name. One `init`, any number of `step_update`s, exactly one
 * `result`.
 *
 * Two things shape this adapter. The conversation id is what `agy`
 * calls a session, and it rides both the init line and every step, so
 * a resume has an id to pass to `--conversation`. And an
 * `agent_response` step streams: ACTIVE updates carry fragments of the
 * message being written, and the DONE update carries the finished
 * text, so the fragments are forwarded as display-only deltas and the
 * transcript takes the DONE step's text.
 *
 * No live stdin session. `agy` has one (`--input-format stream-json`),
 * but nothing here has been able to run the real CLI to confirm how a
 * valueless `-p` behaves alongside it, and a wrong guess is a run that
 * dies at argv parsing. Follow-ups go the way Codex and Cursor's do:
 * delivered when the run ends, with the next run resuming the
 * conversation.
 */
export const antigravityAdapter: AgentAdapter = {
  cli: "antigravity",
  // Antigravity signs in with a Google account by default, which no
  // sandbox can do. GEMINI_API_KEY is the headless route: the
  // toolchain writes modelProvider "gemini" into the sandbox's
  // settings.json, and the key is what the CLI then runs against.
  requiredEnv: ["GEMINI_API_KEY"],
  optionalEnv: ["GOOGLE_GEMINI_BASE_URL"],
  // Local mode only, and only when sharing is switched on: ~/.gemini
  // holds the CLI's own settings and, where the keyring is unavailable,
  // its stored login.
  configPaths: [".gemini"],

  /**
   * `agy` reads MCP servers from the shared config directory rather
   * than a flag, so the whole file is Bento's to overwrite each run.
   * The orchestrator skips this adapter when local mode has the real
   * ~/.gemini mounted read-only over it.
   */
  mcp: {
    renderConfig(servers) {
      const mcpServers = Object.fromEntries(
        servers.map((s) => [s.slug, { serverUrl: s.url, headers: s.headers }]),
      );
      return [
        {
          path: "/root/.gemini/config/mcp_config.json",
          content: JSON.stringify({ mcpServers }, null, 2),
        },
      ];
    },
  },

  buildCommand(input: BuildCommandInput): string[] {
    // The prompt is the value of -p and has to stay next to it: agy
    // treats a valueless prompt flag as an error rather than reading
    // the next flag as the prompt.
    const cmd = [
      "agy",
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      // Our container is the boundary. Without this every tool call
      // waits for an approval nobody is there to give.
      "--dangerously-skip-permissions",
      "--model",
      input.model,
    ];
    if (input.resumeSessionId) cmd.push("--conversation", input.resumeSessionId);
    if (input.extraArgs?.length) cmd.push(...input.extraArgs);
    return cmd;
  },

  /**
   * The fragments an agent_response streams before it finishes. Only
   * the ACTIVE updates: the DONE update carries the finished text and
   * becomes the transcript's message, so forwarding it here as well
   * would type the answer out twice.
   */
  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    const parsed = parseLine(line);
    if (!parsed || parsed.event !== "step_update") return null;
    const step = parsed.step_update;
    if (step?.step_type !== "agent_response" || step.state === "DONE") return null;
    return { channel: "text", text: step.text_delta ?? "" };
  },

  parseEvent(line: string): AgentEvent | null {
    const parsed = parseLine(line);
    if (!parsed) return null;

    if (parsed.event === "init") {
      const ev: AgentEvent = { type: "init", raw: parsed };
      const sessionId = parsed.conversation_id;
      if (sessionId !== undefined) ev.sessionId = sessionId;
      if (parsed.init?.model !== undefined) ev.model = parsed.init.model;
      return ev;
    }

    if (parsed.event === "step_update") {
      const step = parsed.step_update;
      if (!step) return null;
      const phase = step.state === "DONE" ? "end" : "start";

      if (step.subagent_info) {
        const named = step.subagent_info.subagents?.[0]?.type_name;
        return {
          type: "tool",
          name: named ? `subagent ${named}` : "subagent",
          phase,
          detail: step.subagent_info,
          raw: parsed,
        };
      }

      if (step.step_type === "tool") {
        const info = step.tool_info;
        return {
          type: "tool",
          name: info?.name ?? "tool",
          phase,
          detail: phase === "start" ? info?.parameters : (info?.error ?? info?.output),
          raw: parsed,
        };
      }

      if (step.step_type === "agent_response" && phase === "end") {
        // The finished text of the step. Its fragments already went
        // out as deltas, which are display-only, so this is the first
        // and only copy the transcript keeps.
        const text = step.text ?? step.text_delta ?? "";
        if (!text) return null;
        return { type: "message", role: "assistant", text, raw: parsed };
      }

      return null;
    }

    if (parsed.event === "result") {
      const result = parsed.result ?? {};
      const ok = (result.status ?? "").toUpperCase() === "SUCCESS";
      const ev: AgentEvent = { type: "result", ok, raw: parsed };
      const sessionId = result.conversation_id ?? parsed.conversation_id;
      if (sessionId !== undefined) ev.sessionId = sessionId;
      if (result.num_turns !== undefined) ev.numTurns = result.num_turns;
      if (!ok) {
        const reason = describeError(result.error);
        ev.error = reason ?? (result.status ? `agy reported ${result.status.toLowerCase()}` : undefined);
      }
      return ev;
    }

    return null;
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    const init = events.find((e) => e.type === "init");
    const sessionId = result?.sessionId ?? (init?.type === "init" ? init.sessionId : undefined);
    if (!result) {
      const outcome: RunOutcome = {
        ok: false,
        error: `agy stopped before reporting a result (exit code ${exitCode})`,
      };
      // Worth keeping even on a failure: it is what a retry resumes.
      if (sessionId !== undefined) outcome.sessionId = sessionId;
      return outcome;
    }
    // agy exits 0 on success, 1 on a general or API failure, 42 on bad
    // arguments and 53 on the turn limit, so a non-zero exit is a
    // failure whatever the terminal event claimed.
    const outcome: RunOutcome = { ok: result.ok && exitCode === 0 };
    if (sessionId !== undefined) outcome.sessionId = sessionId;
    if (result.numTurns !== undefined) outcome.numTurns = result.numTurns;
    if (!outcome.ok) outcome.error = result.error ?? `exit code ${exitCode}`;
    return outcome;
  },
};

function parseLine(line: string): AntigravityLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as AntigravityLine;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; type?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.type === "string" && record.type.trim()) return record.type;
  }
  return undefined;
}
