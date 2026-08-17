import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import {
  lastResultEvent,
  type AgentAdapter,
  type BuildCommandInput,
  type RecoveredMessage,
} from "./adapter.js";

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
  /**
   * On error results: the actual reasons. A failed resume, for one,
   * arrives as errors: ["No conversation found with session ID: ..."]
   * with no `result` field at all.
   */
  errors?: unknown[];
  total_cost_usd?: number;
  num_turns?: number;
  message?: { role?: string; content?: ClaudeContentBlock[] };
  /**
   * On stream_event lines: the raw Anthropic streaming event. Note the
   * asymmetry, from the API itself: text_delta carries `text`,
   * thinking_delta carries `thinking`.
   */
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
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

  /**
   * stream_event lines are the raw Anthropic streaming events, present
   * because sharedFlags passes --include-partial-messages. Only the
   * text and thinking fragments carry anything a viewer wants; the
   * rest (message_start, content_block boundaries, signature_delta)
   * is consumed as empty fragments so it stays out of the failure
   * tail. Shapes verified against claude 2.1.221's actual output.
   */
  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(trimmed) as ClaudeLine;
    } catch {
      return null;
    }
    if (parsed.type !== "stream_event") return null;
    const delta = parsed.event?.delta;
    if (parsed.event?.type === "content_block_delta" && delta) {
      if (delta.type === "text_delta" && delta.text) return { channel: "text", text: delta.text };
      if (delta.type === "thinking_delta" && delta.thinking) return { channel: "thinking", text: delta.thinking };
    }
    return { channel: "text", text: "" };
  },

  /**
   * Claude Code writes every session to
   * ~/.claude/projects/<slugified cwd>/<sessionId>.jsonl, one JSON
   * entry per message chunk. Assistant entries embed the API message
   * (message.id, message.content), and the same message.id rides the
   * stream-json "assistant" lines this adapter persists, so the
   * delivered/missed diff matches on ids rather than text. Verified
   * against claude 2.x session files: the slug replaces every
   * character outside [A-Za-z0-9] with a dash, sidechain entries are
   * subagent chatter, and one API message can span several entries
   * that share its id.
   */
  sessionRecovery: {
    readLogCommand(sessionId: string, cwd: string): string[] {
      const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
      // The slug and the orchestrator-validated session id are both
      // shell-safe by construction; $HOME resolves inside the sandbox.
      return ["sh", "-c", `cat "$HOME/.claude/projects/${slug}/${sessionId}.jsonl"`];
    },

    parseLog(raw: string): RecoveredMessage[] {
      const order: string[] = [];
      const texts = new Map<string, string>();
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let entry: {
          type?: string;
          isSidechain?: boolean;
          message?: { id?: string; content?: ClaudeContentBlock[] };
        };
        try {
          entry = JSON.parse(trimmed) as typeof entry;
        } catch {
          continue;
        }
        if (entry.type !== "assistant" || entry.isSidechain) continue;
        const id = entry.message?.id;
        if (typeof id !== "string" || !id) continue;
        const text = (entry.message?.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        if (!text) continue;
        if (texts.has(id)) texts.set(id, `${texts.get(id)}\n${text}`);
        else {
          order.push(id);
          texts.set(id, text);
        }
      }
      return order.map((id) => {
        const text = texts.get(id)!;
        // The stream-json line shape, so persistedIds and rendering
        // treat a recovered message like a delivered one.
        return {
          text,
          raw: {
            type: "assistant",
            recovered: true,
            message: { id, role: "assistant", content: [{ type: "text", text }] },
          },
        };
      });
    },

    persistedIds(event: AgentEvent): string[] {
      if (event.type !== "message" || event.role !== "assistant") return [];
      const id = (event.raw as { message?: { id?: unknown } } | undefined)?.message?.id;
      return typeof id === "string" && id !== "" ? [id] : [];
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
      /**
       * Error results do not always carry text in `result`: subtypes
       * like error_during_execution put the reasons in `errors`
       * instead, and error_max_turns can arrive with neither. Checked
       * in that order, with the subtype as the last resort so a
       * reasonless failure never renders as "no reason reported";
       * runAgent appends the stderr tail when only the subtype spoke.
       */
      if (parsed.is_error) {
        const listed = (parsed.errors ?? [])
          .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
          .join("; ");
        ev.error =
          parsed.result ??
          (listed ||
            (parsed.subtype ? `Claude Code reported ${parsed.subtype.replaceAll("_", " ")}` : undefined));
      }
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
    // Streams the message being composed so viewers can watch the
    // typing. Sandboxes install the current CLI, so the flag is safe
    // to assume; it has shipped since well before 2.x.
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--model",
    input.model,
  ];
  if (input.resumeSessionId) flags.push("--resume", input.resumeSessionId);
  if (input.extraArgs?.length) flags.push(...input.extraArgs);
  return flags;
}
