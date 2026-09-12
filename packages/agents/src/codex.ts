import { providerForProfile, type AgentEvent, type RunOutcome } from "@bento/core";
import { lastResultEvent, type AgentAdapter, type BuildCommandInput, type McpRemoteServer } from "./adapter.js";

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; command?: string; status?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** OpenRouter's OpenAI-compatible Responses endpoint. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** Codex's own AI Gateway compatibility endpoint. */
const VERCEL_CODEX_BASE_URL = "https://ai-gateway.vercel.sh/codex/v1";

/**
 * Codex config that names OpenRouter as a custom model_provider.
 *
 * The built-in `openai` provider id is reserved, so pointing
 * openai_base_url at OpenRouter is not how this route works. The
 * table lives in user-level ~/.codex/config.toml (the sandbox home),
 * which is the only file Codex honours for model_providers. Selected
 * at run time with `-c model_provider=openrouter` when OpenRouter is
 * the profile's provider (a slash slug such as openai/gpt-5-mini).
 */
const OPENROUTER_PROVIDER_TOML = [
  "[model_providers.openrouter]",
  'name = "OpenRouter"',
  `base_url = ${tomlString(OPENROUTER_BASE_URL)}`,
  'env_key = "OPENROUTER_API_KEY"',
  'wire_api = "responses"',
].join("\n");

const VERCEL_PROVIDER_TOML = [
  "[model_providers.vercel]",
  'name = "Vercel AI Gateway"',
  `base_url = ${tomlString(VERCEL_CODEX_BASE_URL)}`,
  'env_key = "AI_GATEWAY_API_KEY"',
  'wire_api = "responses"',
].join("\n");

/**
 * OpenAI Codex CLI in non-interactive mode. Codex has its own sandbox,
 * which is redundant inside ours, so it runs with full access and our
 * container provides the boundary.
 */
export const codexAdapter: AgentAdapter = {
  cli: "codex",
  requiredEnv: ["OPENAI_API_KEY"],
  optionalEnv: ["OPENAI_BASE_URL"],
  /**
   * OpenRouter selected as the provider needs the OpenRouter key, not
   * the OpenAI one. Bare OpenAI ids still need OPENAI_API_KEY.
   */
  requiredEnvFor(model) {
    if (vercelSelected(model)) return ["AI_GATEWAY_API_KEY"];
    return openRouterSelected(model) ? ["OPENROUTER_API_KEY"] : ["OPENAI_API_KEY"];
  },
  configPaths: [".codex"],

  /**
   * Codex 0.153 ignores OPENAI_API_KEY for its built in provider: with
   * only that set, it called api.openai.com with no Authorization header
   * at all ("Missing bearer"). CODEX_API_KEY is the variable `codex exec`
   * reads, so the stored key is handed over under that name.
   */
  env(input: BuildCommandInput): Record<string, string> {
    // OpenRouter authenticates through OPENROUTER_API_KEY on the
    // custom provider. Remapping a leftover OpenAI key would put
    // CODEX_API_KEY in a sandbox that should not see it.
    if (openRouterSelected(input.model) || vercelSelected(input.model)) return {};
    const key = input.credentials?.OPENAI_API_KEY;
    return key ? { CODEX_API_KEY: key } : {};
  },

  /**
   * Codex reads remote MCP servers from config.toml: a [mcp_servers.<name>]
   * table with a url and a static http_headers table (v0.131.0+, no
   * experimental flag). The sandbox home is Bento's to write, and the
   * orchestrator skips this adapter when local mode has ~/.codex mounted
   * read-only over it.
   *
   * The OpenRouter and Vercel AI Gateway providers are always defined
   * here so `-c model_provider` has a table to select, including on
   * runs with no MCP servers. An empty server list still writes both,
   * so a removed server is cleared without dropping either route.
   */
  mcp: {
    renderConfig(servers) {
      return [{ path: "/root/.codex/config.toml", content: renderCodexConfig(servers) }];
    },
  },

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
      vercelSelected(input.model) ? input.model.slice("vercel/".length) : input.model,
    );
    if (vercelSelected(input.model)) {
      cmd.push(...vercelConfigOverrides());
    } else if (openRouterSelected(input.model)) {
      // OpenRouter is the selected provider: tell Codex to use that
      // model_provider. -c still applies when ~/.codex is mounted
      // read-only and the config file above was not written. Nested
      // keys create the provider table if it is missing.
      cmd.push(...openRouterConfigOverrides());
    } else {
      // OPENAI_BASE_URL is ignored as an env var the same way the key
      // is, so a non-OpenRouter gateway the organization saved arrives
      // as the config key that replaced the variable. Before the
      // profile's own args, so a -c there comes later.
      const baseUrl = input.credentials?.OPENAI_BASE_URL;
      if (baseUrl) cmd.push("-c", `openai_base_url=${tomlString(baseUrl)}`);
    }
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

/**
 * Whether this Codex profile has OpenRouter selected as its provider.
 *
 * Native ids are bare (`gpt-5-codex`). The picker writes an OpenRouter
 * catalog slug when that provider is chosen, and those slugs contain a
 * slash (`openai/gpt-5-mini`, `openrouter/auto`). providerForProfile is
 * the same answer the pairing chip uses, so the adapter selects Codex's
 * `model_provider=openrouter` exactly when OpenRouter is selected.
 */
function openRouterSelected(model: string): boolean {
  return providerForProfile("codex", model)?.id === "openrouter";
}

function vercelSelected(model: string): boolean {
  // The prefix is the selection. Do not ask providerForProfile: a
  // slash on Codex is otherwise OpenRouter, and that answer is what
  // this prefix exists to override.
  return model.startsWith("vercel/");
}

function openRouterConfigOverrides(): string[] {
  return [
    "-c",
    'model_provider="openrouter"',
    "-c",
    'model_providers.openrouter.name="OpenRouter"',
    "-c",
    `model_providers.openrouter.base_url=${tomlString(OPENROUTER_BASE_URL)}`,
    "-c",
    'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    "-c",
    'model_providers.openrouter.wire_api="responses"',
  ];
}

function vercelConfigOverrides(): string[] {
  return [
    "-c",
    'model_provider="vercel"',
    "-c",
    'model_providers.vercel.name="Vercel AI Gateway"',
    "-c",
    `model_providers.vercel.base_url=${tomlString(VERCEL_CODEX_BASE_URL)}`,
    "-c",
    'model_providers.vercel.env_key="AI_GATEWAY_API_KEY"',
    "-c",
    'model_providers.vercel.wire_api="responses"',
  ];
}

function renderCodexConfig(servers: McpRemoteServer[]): string {
  const mcp = servers
    .map((server) => {
      const headers = Object.entries(server.headers)
        .map(([name, value]) => `${tomlString(name)} = ${tomlString(value)}`)
        .join(", ");
      return [
        `[mcp_servers.${tomlKey(server.slug)}]`,
        `url = ${tomlString(server.url)}`,
        headers ? `http_headers = { ${headers} }` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  return [OPENROUTER_PROVIDER_TOML, VERCEL_PROVIDER_TOML, mcp].filter(Boolean).join("\n\n") + "\n";
}

/** A TOML basic string, escaping the characters TOML requires. */
function tomlString(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

/** A TOML bare key when the slug allows it, otherwise a quoted key. */
function tomlKey(slug: string): string {
  return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : tomlString(slug);
}
