import type { AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import { hasOllamaCredentials, isOllamaModel, ollamaModelId, ollamaServerUrl } from "@bento/core";
import {
  providerKeyFor,
  type AgentAdapter,
  type BuildCommandInput,
  type RecoveredMessage,
} from "./adapter.js";
import { opencodeAcpProtocol, parseAcpDelta } from "./opencode-acp.js";

interface OpencodePart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string };
  id?: string;
  messageID?: string;
}

/** The shape `opencode export <sessionID>` prints, as of opencode 1.18. */
interface OpencodeExport {
  messages?: {
    info?: { role?: string; id?: string };
    parts?: OpencodePart[];
  }[];
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
  optionalEnv: [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
  ],
  configPaths: [".config/opencode", ".local/share/opencode"],

  /**
   * opencode ships no provider for an Ollama server, so an ollama/ model
   * brings one as OPENCODE_CONFIG_CONTENT, which opencode merges over its
   * config files: the opencode.json Bento writes for MCP servers stays as
   * it is. The key is referenced rather than inlined, since it already
   * travels in the environment as OLLAMA_API_KEY.
   */
  env(input: BuildCommandInput): Record<string, string> {
    // Without Ollama credentials saved in Bento, ollama/ is the provider
    // of that name in the user's own opencode config, as it was before
    // Bento offered Ollama.
    if (isOllamaModel(input.model) && hasOllamaCredentials(input.credentials ?? {})) {
      const id = ollamaModelId(input.model);
      const options: Record<string, string> = {
        baseURL: `${ollamaServerUrl(input.credentials?.OLLAMA_BASE_URL)}/v1`,
      };
      if (input.credentials?.OLLAMA_API_KEY) options.apiKey = "{env:OLLAMA_API_KEY}";
      const config = {
        $schema: "https://opencode.ai/config.json",
        provider: {
          ollama: { npm: "@ai-sdk/openai-compatible", name: "Ollama", options, models: { [id]: { name: id } } },
        },
      };
      return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    }
    // /connect stores the Gateway key in opencode's own auth. A sandbox
    // has none of that, so the built-in vercel provider is pointed at
    // the key Bento already forwarded.
    if (input.model.startsWith("vercel/") && input.credentials?.AI_GATEWAY_API_KEY) {
      return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            vercel: { options: { apiKey: "{env:AI_GATEWAY_API_KEY}" } },
          },
        }),
      };
    }
    return {};
  },

  // The sandbox home carries no opencode config of its own, so the
  // whole file is Bento's to overwrite each run. The orchestrator skips
  // this adapter when local mode has the real config mounted over it.
  mcp: {
    renderConfig(servers) {
      const mcp = Object.fromEntries(
        servers.map((s) => [s.slug, { type: "remote", url: s.url, headers: s.headers, enabled: true }]),
      );
      return [
        {
          path: "~/.config/opencode/opencode.json",
          content: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2),
        },
      ];
    },
  },

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

  /**
   * `opencode acp`, its Agent Client Protocol server on stdio (see
   * opencode-acp.ts for what was verified and how). A message sent
   * mid-turn is queued by opencode and read at its next model call.
   * Beta, so every other run keeps `opencode run`.
   */
  live: {
    delivery: "queue",
    beta: true,
    interrupts: true,
    /**
     * Not with profile arguments: they were written for `opencode run`
     * (`--agent`, `--variant`), and `opencode acp` takes none of them.
     */
    appliesTo: (input) => !input.extraArgs?.length,
    buildCommand(input: BuildCommandInput): string[] {
      // The model is chosen over the protocol: `opencode acp` has no -m.
      return ["opencode", "acp", "--print-logs", "--cwd", input.cwd];
    },
    connect: (input, how) => opencodeAcpProtocol(input, how),
  },

  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    return parseAcpDelta(line);
  },

  /**
   * `opencode export` prints the session as one JSON document, read
   * from the same storage the TUI's session list uses. Verified
   * against opencode 1.18: messages carry info.role and info.id
   * (msg_...), and each part carries its own id (prt_...) plus its
   * messageID. Those are the same ids the live stream stamps on every
   * "text" line's part, which is what makes the delivered/missed diff
   * exact rather than a text comparison.
   */
  sessionRecovery: {
    readLogCommand(sessionId: string): string[] {
      return ["opencode", "export", sessionId];
    },

    parseLog(raw: string): RecoveredMessage[] {
      let parsed: OpencodeExport;
      try {
        parsed = JSON.parse(raw) as OpencodeExport;
      } catch {
        return [];
      }
      const recovered: RecoveredMessage[] = [];
      for (const message of parsed.messages ?? []) {
        if (message.info?.role !== "assistant") continue;
        const texts = (message.parts ?? []).filter((part) => part.type === "text" && part.text);
        for (const part of texts) {
          // Rebuilt in the live stream's own line shape, so everything
          // downstream (rendering, persistedIds, a later recovery)
          // treats it exactly like a message that arrived on time.
          recovered.push({
            text: part.text!,
            raw: {
              type: "text",
              recovered: true,
              part: {
                /**
                 * A message with one text part is named by its message
                 * id alone. A live session (ACP) never learns part ids,
                 * so its transcript holds only the message id, and a
                 * part id here would make every such message look
                 * missing and be recovered again. One part means the
                 * message id is exact: if it was persisted, so was this.
                 * A message of several parts keeps each part's id, so
                 * the one that arrived during the gap is still found.
                 */
                ...(texts.length > 1 ? { id: part.id } : {}),
                messageID: part.messageID ?? message.info.id,
                type: "text",
                text: part.text,
              },
            },
          });
        }
      }
      return recovered;
    },

    persistedIds(event: AgentEvent): string[] {
      if (event.type !== "message" || event.role !== "assistant") return [];
      const part = (event.raw as { part?: { id?: unknown; messageID?: unknown } } | undefined)?.part;
      return [part?.id, part?.messageID].filter((id): id is string => typeof id === "string" && id !== "");
    },
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
    // A turn a person interrupted is not the run failing, once another
    // turn came after it; the last one still decides.
    const failure = events.find(
      (e, index) =>
        e.type === "result" && !e.ok && !(e.interrupted && events.slice(index + 1).some((later) => later.type === "result")),
    );
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
