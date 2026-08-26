import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import type { AgentAdapter, BuildCommandInput } from "./adapter.js";

/** Poolside-hosted inference, which is where a Platform key is valid. */
const POOLSIDE_BASE_URL = "https://inference.poolside.ai/v1";

interface PoolLine {
  type?: string;
  /** assistantMessage: the prose the agent addresses to the reader. */
  message?: string;
  /** reasoning and thought: the model's own thinking, verbatim. */
  reasoning?: string;
  thought?: string;
  /** toolCall. */
  name?: string;
  args?: unknown;
  /** toolCallResult. */
  result?: string;
  /** Fatal records, which carry no type at all. */
  error?: string;
}

/**
 * Poolside's agent CLI in headless mode.
 *
 * Three things about `pool exec` shape this adapter, and all three were
 * read off the real CLI (v1.0.16) rather than its documentation:
 *
 * 1. **The model is not a flag.** `pool exec` takes no --model, so it
 *    travels as POOLSIDE_STANDALONE_MODEL through the env hook, beside
 *    the base URL that puts the CLI in standalone mode at all: with an
 *    API key and no URL it stops at "unable to resolve api url".
 * 2. **The stream carries no run id.** Run ids exist (pool writes one
 *    per run under ~/.local/state/poolside/sessions, and
 *    `--continue=<run-id>` resumes it) but nothing prints one, in json
 *    or in markdown. So no init event and no session id: every message
 *    on a card starts a fresh run with the full stage prompt, which is
 *    honest, where a bare `--continue` would resume whatever ran in
 *    that sandbox last, from another card or another stage.
 * 3. **Its exit codes are documented and behave**: 0 for a completed
 *    task, 4 for one the agent says it could not do, anything else
 *    unexpected. Unlike Cursor, the code can be trusted, and unlike
 *    opencode there is no terminal event to read instead.
 *
 * Credentials are the Poolside key alone. A `pool login` session on the
 * machine is deliberately not mounted: the login is only consulted when
 * no base URL is set, and the base URL is what the key path needs, so
 * offering both would mean a shared login that silently never applied.
 *
 * https://docs.poolside.ai/cli/automated-mode
 */
export const poolAdapter: AgentAdapter = {
  cli: "pool",
  requiredEnv: ["POOLSIDE_API_KEY"],
  // Any OpenAI-compatible endpoint: a self managed Poolside
  // deployment, a gateway, or another provider entirely. Unset means
  // Poolside Platform, which the env hook fills in below.
  optionalEnv: ["POOLSIDE_STANDALONE_BASE_URL"],

  env(input: BuildCommandInput): Record<string, string> {
    return {
      POOLSIDE_STANDALONE_BASE_URL: POOLSIDE_BASE_URL,
      POOLSIDE_STANDALONE_MODEL: input.model,
    };
  },

  buildCommand(input: BuildCommandInput): string[] {
    const argv = [
      "pool",
      "exec",
      "-o",
      "json",
      // Our sandbox is the boundary: approve tool actions and leave
      // pool's own sandboxing to the machine we already isolated.
      "--unsafe-auto-allow",
      "--sandbox",
      "disabled",
      "-d",
      input.cwd,
    ];
    // Attached with = rather than as a separate argument: --continue is
    // valid alone, meaning "the last run in this sandbox", so a
    // detached value could be read as the prompt and the flag as that.
    // Nothing sets resumeSessionId for pool today (see above), so this
    // is the path a captured run id would take, not one runs use.
    if (input.resumeSessionId) argv.push(`--continue=${input.resumeSessionId}`);
    if (input.extraArgs?.length) argv.push(...input.extraArgs);
    argv.push("-p", input.prompt);
    return argv;
  },

  parseEvent(line: string): AgentEvent | null {
    const parsed = parseLine(line);
    if (!parsed) return null;

    // A fatal record has an error and no type: a refused key, a model
    // the endpoint does not serve, a run id that is not there.
    if (!parsed.type && parsed.error) {
      return { type: "result", ok: false, error: parsed.error, raw: parsed };
    }

    switch (parsed.type) {
      case "assistantMessage": {
        const text = parsed.message ?? "";
        if (!text) return null;
        return { type: "message", role: "assistant", text, raw: parsed };
      }
      case "thought": {
        // The turn's thinking, in full, once it is over. The reasoning
        // records that carried the same words while it worked are
        // consumed by parseDelta, so this is where thinking is kept.
        const text = parsed.thought ?? "";
        if (!text) return null;
        return { type: "message", role: "system", text, raw: parsed };
      }
      case "toolCall": {
        return {
          type: "tool",
          name: parsed.name ?? "tool",
          phase: "start",
          detail: parsed.args,
          raw: parsed,
        };
      }
      case "toolCallResult": {
        // The record names no tool: the pairing is positional, and a
        // guess at which call this closes would be worse than none.
        return { type: "tool", name: "tool", phase: "end", raw: parsed };
      }
      case "oauth_url": {
        return {
          type: "result",
          ok: false,
          error:
            "Poolside wants a browser login, which a sandbox cannot do. Check the saved POOLSIDE_API_KEY.",
          raw: parsed,
        };
      }
      default:
        return null;
    }
  },

  /**
   * reasoning records arrive whole rather than as fragments, and the
   * thought record repeats them at the end of the turn, so there is
   * nothing to forward: they are consumed as chatter. Consuming them
   * matters anyway, because a run that dies keeps its stderr tail for
   * the error, and a page of reasoning JSON would bury it.
   */
  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    const parsed = parseLine(line);
    if (!parsed || parsed.type !== "reasoning") return null;
    return { channel: "thinking", text: "" };
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const failure = events.findLast((e) => e.type === "result" && !e.ok);
    if (failure && failure.type === "result") {
      return { ok: false, error: failure.error ?? `exit code ${exitCode}` };
    }
    if (exitCode === 0) return { ok: true };
    // 4 is pool saying the agent finished and could not do the task,
    // which is a different thing from the CLI falling over, and the
    // transcript above it holds the agent's own account either way.
    return {
      ok: false,
      error:
        exitCode === 4
          ? "pool reported the task as not completed (exit code 4)"
          : `pool stopped before reporting a result (exit code ${exitCode})`,
    };
  },
};

function parseLine(line: string): PoolLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as PoolLine;
  } catch {
    return null;
  }
}
