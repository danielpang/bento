import type { AgentEvent, RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput } from "./adapter.js";

/**
 * The one JSON object `fx ask --json` prints on stdout. Progress stays
 * on stderr. Captured from fx 0.0.9: the object is compact, one line,
 * even when the request fails before a model is chosen.
 *
 * https://fx.sh/docs/using-fx/fx-ask
 */
interface FxAskJson {
  output?: string;
  final_output?: string;
  exit_code?: number;
  model?: string;
  session_id?: string;
  steps?: number;
  error?: string;
  tool_calls?: { name?: string; status?: string }[];
}

/**
 * Vercel's fx CLI (`fx`) in headless `ask` mode.
 *
 * fx is a coding agent harness, not a model provider. The default
 * inference path is Vercel AI Gateway: one `AI_GATEWAY_API_KEY`, and
 * every model is a Gateway slug (`moonshotai/kimi-k3`,
 * `openai/gpt-5.4`). That is the same shape as an OpenRouter id, but
 * a different key, catalog, and bill. Anthropic, OpenAI, and the
 * other vendor keys Bento already stores are not read. Codex and Grok
 * subscriptions exist as interactive `fx login` providers; a sandbox
 * has no browser, so they are out of reach here.
 *
 * `fx ask --json` prints one object when the process exits, not an
 * event stream, so the transcript is quiet until the run ends. The
 * session id in that object is what `--resume` takes on the next run.
 *
 * `--full-access` disables fx's own permission checks: Bento's
 * sandbox is the boundary, the same reason Muse gets `--yolo` and
 * Cursor gets `--trust`. `FX_MODEL` is the documented process
 * override; `fx ask` has no `--model` flag.
 *
 * https://fx.sh/docs
 */
export const fxAdapter: AgentAdapter = {
  cli: "fx",
  requiredEnv: ["AI_GATEWAY_API_KEY"],
  configPaths: [".fx"],

  env(input: BuildCommandInput): Record<string, string> {
    return {
      FX_MODEL: input.model,
      FX_PERMISSION_MODE: "full-access",
      FX_AUTO_UPGRADE: "0",
      FX_NO_OPEN_BROWSER: "1",
    };
  },

  /**
   * fx reads MCP servers from ~/.fx/mcp.json. The whole file is
   * Bento's to overwrite each run. The orchestrator skips this
   * adapter when local mode has the real ~/.fx mounted over it.
   *
   * A literal Authorization header is rejected (McpConfigInvalidHeaders
   * on fx 0.0.9), and header_env for that name is rejected too. The
   * documented Bearer path is bearer_token_env. required stays false
   * so a down gateway does not block the model turn; Muse uses the
   * same optional stance.
   */
  mcp: {
    renderConfig(servers) {
      const mcp = Object.fromEntries(
        servers.map((s) => [
          s.slug,
          {
            type: s.transport === "sse" ? "sse" : "http",
            url: s.url,
            ...(grantToken(s.headers) ? { bearer_token_env: FX_GRANT_ENV } : {}),
            enabled: true,
            required: false,
          },
        ]),
      );
      return [
        {
          path: "/root/.fx/mcp.json",
          content: JSON.stringify({ mcp }, null, 2),
        },
      ];
    },
    env(servers) {
      const token = servers.map((s) => grantToken(s.headers)).find(Boolean);
      return token ? { [FX_GRANT_ENV]: token } : {};
    },
  },

  buildCommand(input: BuildCommandInput): string[] {
    const cmd = ["fx", "ask", "--json", "--full-access", "--no-color"];
    if (input.resumeSessionId) cmd.push("--resume", input.resumeSessionId);
    if (input.extraArgs?.length) cmd.push(...input.extraArgs);
    // So a prompt that looks like a flag is still the prompt.
    cmd.push("--", input.prompt);
    return cmd;
  },

  parseEvent(line: string): AgentEvent | null {
    const parsed = parseAskJson(line);
    if (!parsed) return null;

    const sessionId = nonempty(parsed.session_id);
    const failed = parsed.exit_code !== undefined && parsed.exit_code !== 0;
    if (failed || parsed.error) {
      const ev: AgentEvent = { type: "result", ok: false, raw: parsed };
      if (sessionId) ev.sessionId = sessionId;
      const error = nonempty(parsed.error);
      if (error) ev.error = error;
      return ev;
    }

    const text = nonempty(parsed.final_output) ?? nonempty(parsed.output);
    if (text) {
      return { type: "message", role: "assistant", text, raw: parsed };
    }

    const ev: AgentEvent = { type: "result", ok: true, raw: parsed };
    if (sessionId) ev.sessionId = sessionId;
    if (parsed.steps !== undefined) ev.numTurns = parsed.steps;
    return ev;
  },

  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome {
    const result = lastResultEvent(events);
    const message = events.find((event) => event.type === "message" && event.role === "assistant");
    const sessionId = sessionIdOf(result) ?? sessionIdOf(message);
    if (result && !result.ok) {
      const outcome: RunOutcome = { ok: false, error: result.error ?? `exit code ${exitCode}` };
      if (sessionId) outcome.sessionId = sessionId;
      return outcome;
    }
    if (exitCode !== 0) {
      const outcome: RunOutcome = {
        ok: false,
        error: `fx stopped before reporting a result (exit code ${exitCode})`,
      };
      if (sessionId) outcome.sessionId = sessionId;
      return outcome;
    }
    if (!message && !result) {
      return { ok: false, error: "fx finished without readable output" };
    }
    const outcome: RunOutcome = { ok: true };
    if (sessionId) outcome.sessionId = sessionId;
    const turns = result?.numTurns ?? stepsOf(message);
    if (turns !== undefined) outcome.numTurns = turns;
    return outcome;
  },
};

const FX_GRANT_ENV = "BENTO_MCP_GRANT";

/** The raw run grant, never the "Bearer " prefix fx adds itself. */
function grantToken(headers: Record<string, string>): string | undefined {
  const value = headers.Authorization ?? headers.authorization;
  if (!value) return undefined;
  return nonempty(value.replace(/^Bearer\s+/i, ""));
}

function parseAskJson(line: string): FxAskJson | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: FxAskJson;
  try {
    parsed = JSON.parse(trimmed) as FxAskJson;
  } catch {
    return null;
  }
  // The fields that make this fx ask's document rather than another
  // tool's event line. A Codex or Muse envelope can carry a session
  // id; none of them puts exit_code next to final_output.
  if (typeof parsed.exit_code !== "number") return null;
  if (parsed.final_output === undefined && parsed.session_id === undefined && parsed.error === undefined) {
    return null;
  }
  return parsed;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sessionIdOf(event: AgentEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (event.type === "init" || event.type === "result") {
    if (event.sessionId) return event.sessionId;
  }
  const raw = event.raw as FxAskJson | undefined;
  return nonempty(raw?.session_id);
}

function stepsOf(event: AgentEvent | undefined): number | undefined {
  const raw = event?.raw as FxAskJson | undefined;
  return raw?.steps;
}
