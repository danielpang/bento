import type { AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, providerKeyFor, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

/**
 * pi, the open source BYOK coding agent from earendil-works.
 *
 * Unlike the other adapters, pi is provider agnostic: one agent loop over
 * Anthropic, OpenAI, Google and others, selected by a `provider/id` model
 * string. So it declares no required credential and accepts whichever
 * keys the organization has stored.
 *
 * `--mode json` emits the session's events as NDJSON. The first line is a
 * session header carrying the id used to resume.
 *
 * https://github.com/earendil-works/pi
 */
export const piAdapter: AgentAdapter = {
  cli: "pi",
  requiredEnv: [],
  requiredEnvFor: providerKeyFor,
  // Whichever of these is present decides which provider pi can reach.
  optionalEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"],
  configPaths: [".pi"],

  buildCommand(input: BuildCommandInput): string[] {
    const argv = ["pi", "--mode", "json", "--print", "--model", input.model];
    // A partial id is accepted, so the stored session id works as is.
    if (input.resumeSessionId) argv.push("--session", input.resumeSessionId);
    if (input.extraArgs?.length) argv.push(...input.extraArgs);
    argv.push(input.prompt);
    return argv;
  },

  /**
   * pi's RPC mode is built for exactly this: JSON commands on stdin,
   * the same event stream on stdout. A mid-task message is a steer,
   * pi's own word: delivered after the in-flight tool call, before the
   * next model turn.
   */
  live: {
    delivery: "steer",
    buildCommand(input: BuildCommandInput): string[] {
      const argv = ["pi", "--mode", "rpc", "--model", input.model];
      if (input.resumeSessionId) argv.push("--session", input.resumeSessionId);
      if (input.extraArgs?.length) argv.push(...input.extraArgs);
      return argv;
    },
    encodeMessage(text: string, kind: "initial" | "followUp"): string {
      // steer rather than follow_up for mid-task messages: reaching
      // the agent while it works is the point of the live session.
      return kind === "initial"
        ? JSON.stringify({ type: "prompt", message: text })
        : JSON.stringify({ type: "steer", message: text });
    },
  },

  parseEvent(line: string): AgentEvent | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;

    let parsed: PiLine;
    try {
      parsed = JSON.parse(trimmed) as PiLine;
    } catch {
      return null;
    }

    switch (parsed.type) {
      // The header, which is where the resumable session id comes from.
      case "session":
        return {
          type: "init",
          ...(parsed.id ? { sessionId: parsed.id } : {}),
          raw: parsed,
        };

      /**
       * message_end carries the finished assistant message. message_update
       * is deliberately ignored: it fires per token delta, and persisting
       * one row per delta would bury the transcript.
       */
      case "message_end": {
        const text = assistantText(parsed.message);
        if (!text) return null;
        return { type: "message", role: "assistant", text, raw: parsed };
      }

      case "tool_execution_start":
        return { type: "tool", name: parsed.toolName ?? "tool", phase: "start", raw: parsed };

      case "tool_execution_end":
        return { type: "tool", name: parsed.toolName ?? "tool", phase: "end", raw: parsed };

      /**
       * agent_end closes the run. Cost and turns are summed from the
       * assistant messages, because pi reports usage per message rather
       * than once at the end.
       */
      case "agent_end": {
        const messages = parsed.messages ?? [];
        const assistants = messages.filter((m) => m.role === "assistant");
        const costUsd = assistants.reduce((total, m) => total + (m.usage?.cost?.total ?? 0), 0);
        // A message that stopped on an error is how pi reports failure.
        const failed = assistants.find((m) => m.errorMessage);
        return {
          type: "result",
          ok: !failed,
          ...(failed?.errorMessage ? { error: failed.errorMessage } : {}),
          costUsd,
          numTurns: assistants.length,
          raw: parsed,
        };
      }

      default:
        return null;
    }
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    // pi can exit non-zero without emitting agent_end, for example when
    // the model or a credential is rejected before the loop starts.
    if (!result) {
      return { ok: false, error: `pi stopped before reporting a result (exit code ${exitCode})` };
    }

    const init = events.find((e) => e.type === "init");
    const sessionId = init && "sessionId" in init ? init.sessionId : undefined;

    if (!result.ok || exitCode !== 0) {
      return {
        ok: false,
        error: result.error ?? `pi exited with code ${exitCode}`,
        ...(sessionId ? { sessionId } : {}),
      };
    }
    return {
      ok: true,
      ...(sessionId ? { sessionId } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      ...(result.numTurns !== undefined ? { numTurns: result.numTurns } : {}),
    };
  },
};

interface PiUsage {
  cost?: { total?: number };
}

interface PiMessage {
  role?: string;
  content?: ({ type?: string; text?: string } | unknown)[];
  usage?: PiUsage;
  errorMessage?: string;
}

interface PiLine {
  type?: string;
  id?: string;
  toolName?: string;
  message?: PiMessage;
  messages?: PiMessage[];
}

/** Assistant content is a list of blocks; only the text ones are prose. */
function assistantText(message: PiMessage | undefined): string {
  if (!message?.content) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    const candidate = block as { type?: string; text?: string };
    if (candidate?.type === "text" && candidate.text) parts.push(candidate.text);
  }
  return parts.join("").trim();
}
