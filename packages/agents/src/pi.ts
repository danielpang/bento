import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, providerBaseUrl, providerKeyFor, type AgentAdapter, type BuildCommandInput, type McpFile } from "./adapter.js";
import { PI_ASK_USER_ENV, PI_ASK_USER_EXTENSION, PI_ASK_USER_PATH, piLiveProtocol } from "./pi-live.js";

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
  optionalEnv: [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
  ],
  configPaths: [".pi"],
  /**
   * pi takes a built-in provider's base URL only from models.json,
   * where setting `baseUrl` alone on a built-in provider id re-routes
   * every model of it and keeps its auth (pi's docs/models.md, "route a
   * built-in provider through a proxy"). So the proxy's addresses reach
   * pi as that file in the sandbox home.
   */
  modelProxy: {
    keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"],
    homeFile: true,
  },

  files(input: BuildCommandInput) {
    const files: McpFile[] = [];
    if (input.askUser) files.push({ path: PI_ASK_USER_PATH, content: PI_ASK_USER_EXTENSION });
    const providers: Record<string, unknown> = piProviderBaseUrls(input);
    const provider = input.customProvider;
    if (provider) {
      providers[provider.slug] = {
        baseUrl: provider.baseUrl,
        api: provider.protocol === "anthropic" ? "anthropic-messages"
          : provider.protocol === "openai-responses" ? "openai-responses" : "openai-completions",
        apiKey: "$BENTO_CUSTOM_PROVIDER_API_KEY",
        models: provider.models,
      };
    }
    if (Object.keys(providers).length === 0) return files;
    return [...files, { path: "~/.pi/agent/models.json", content: JSON.stringify({ providers }) }];
  },

  /**
   * The ask_user extension stays in the sandbox once written, and loads
   * in every pi run there; it registers its tool only for a run that a
   * person can answer.
   */
  env(input: BuildCommandInput): Record<string, string> {
    return input.askUser ? { [PI_ASK_USER_ENV]: "1" } : {};
  },

  buildCommand(input: BuildCommandInput): string[] {
    const argv = ["pi", "--mode", "json", "--print", ...piModelArgs(input.model)];
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
   * next model turn. Where a person can answer, Bento's ask_user
   * extension is there too (see pi-live.ts).
   */
  live: {
    delivery: "steer",
    interrupts: true,
    buildCommand(input: BuildCommandInput): string[] {
      const argv = ["pi", "--mode", "rpc", ...piModelArgs(input.model)];
      if (input.resumeSessionId) argv.push("--session", input.resumeSessionId);
      if (input.extraArgs?.length) argv.push(...input.extraArgs);
      return argv;
    },
    connect: () => piLiveProtocol(),
  },

  /**
   * message_update, the event parseEvent deliberately drops, is where
   * the live typing lives. In JSON mode each one carries an
   * assistantMessageEvent with the fragment and no cumulative
   * snapshot ("message_start provides the initial message, deltas
   * build it, and message_end provides the final authoritative
   * message", pi's own words), so the fragment is appended, not
   * replaced.
   */
  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return null;
    let parsed: PiLine;
    try {
      parsed = JSON.parse(trimmed) as PiLine;
    } catch {
      return null;
    }
    if (parsed.type !== "message_update") return null;
    const inner = parsed.assistantMessageEvent;
    if (typeof inner?.delta === "string" && inner.delta !== "") {
      if (inner.type === "text_delta") return { channel: "text", text: inner.delta };
      if (inner.type === "thinking_delta") return { channel: "thinking", text: inner.delta };
    }
    // The rest of message_update is chatter: toolcall_delta streams
    // half a JSON object, starts and ends carry no new prose. Consumed
    // as empty so it stays out of the failure tail.
    return { channel: "text", text: "" };
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
        // An abort, which only a live session's interrupt sends: the
        // turn stopped for a person, and the session goes on.
        if (assistants.at(-1)?.stopReason === "aborted") {
          return { type: "result", ok: false, interrupted: true, error: "Interrupted.", costUsd, numTurns: assistants.length, raw: parsed };
        }
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
  /** Why the model call ended; "aborted" when an abort command stopped it. */
  stopReason?: string;
}

interface PiLine {
  type?: string;
  id?: string;
  toolName?: string;
  message?: PiMessage;
  messages?: PiMessage[];
  /** On message_update: the streaming fragment (pi-ai's event shape). */
  assistantMessageEvent?: { type?: string; delta?: string };
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

/**
 * pi's first-class Gateway provider is `vercel-ai-gateway`, not
 * `vercel`. The picker writes `vercel/<slug>` so every tool shares one
 * catalog id; this is the rewrite that provider expects.
 */
/**
 * Built-in providers pointed at the base URLs this run was given, in
 * the shape each one's built-in models use (read off pi 1.4.0's own
 * catalog): Anthropic, DeepSeek and AI Gateway at the origin, OpenAI
 * with /v1, Google with /v1beta. OpenRouter serves its anthropic/
 * models over Anthropic's API at /api and the rest over OpenAI's at
 * /api/v1, and one provider has one base URL, so the run's own model
 * decides which. Nothing for a provider the run was given no base URL
 * for, so pi's own default stands.
 */
function piProviderBaseUrls(input: BuildCommandInput): Record<string, { baseUrl: string }> {
  const credentials = input.credentials ?? {};
  const out: Record<string, { baseUrl: string }> = {};
  const set = (provider: string, name: string, suffix = "") => {
    if (!credentials[name]?.trim()) return;
    out[provider] = { baseUrl: `${providerBaseUrl(credentials, name, "")}${suffix}` };
  };
  set("anthropic", "ANTHROPIC_BASE_URL");
  set("openai", "OPENAI_BASE_URL");
  set("google", "GOOGLE_GEMINI_BASE_URL", "/v1beta");
  set("deepseek", "DEEPSEEK_BASE_URL");
  set("vercel-ai-gateway", "AI_GATEWAY_BASE_URL");
  set("openrouter", "OPENROUTER_BASE_URL", input.model.startsWith("openrouter/anthropic/") ? "/api" : "/api/v1");
  return out;
}

function piModelArgs(model: string): string[] {
  if (model.startsWith("vercel/")) {
    return ["--provider", "vercel-ai-gateway", "--model", model.slice("vercel/".length)];
  }
  return ["--model", model];
}
