import { providerForProfile, type AgentDelta, type AgentEvent, type RunOutcome } from "@bento/core";
import { lastResultEvent, providerBaseUrl, type AgentAdapter, type BuildCommandInput, type McpRemoteServer } from "./adapter.js";
import { codexAppServerProtocol, parseAppServerDelta, parseAppServerEvent } from "./codex-app-server.js";
import { readRpcLine } from "./live-wire.js";

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; command?: string; status?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  /** Set on app-server notifications, which a live session reads. */
  method?: string;
  params?: unknown;
}

/** OpenRouter's origin; its OpenAI-compatible Responses endpoint is under /api/v1. */
const OPENROUTER_ORIGIN = "https://openrouter.ai";
/** Vercel AI Gateway's origin; Codex's own compatibility endpoint is under /codex/v1. */
const AI_GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
/** OpenRouter's OpenAI-compatible Responses endpoint. */
const OPENROUTER_BASE_URL = `${OPENROUTER_ORIGIN}/api/v1`;
/** Codex's own AI Gateway compatibility endpoint. */
const VERCEL_CODEX_BASE_URL = `${AI_GATEWAY_ORIGIN}/codex/v1`;

/**
 * Where a run's OpenRouter and AI Gateway calls go: the provider's own
 * endpoint, or, when the model proxy carries the key, the same path
 * under the proxy's address for that provider (OPENROUTER_BASE_URL and
 * AI_GATEWAY_BASE_URL are origins, so the path is Codex's to add).
 */
function openRouterBaseUrl(credentials: BuildCommandInput["credentials"]): string {
  return `${providerBaseUrl(credentials, "OPENROUTER_BASE_URL", OPENROUTER_ORIGIN)}/api/v1`;
}
function vercelCodexBaseUrl(credentials: BuildCommandInput["credentials"]): string {
  return `${providerBaseUrl(credentials, "AI_GATEWAY_BASE_URL", AI_GATEWAY_ORIGIN)}/codex/v1`;
}

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
   * Every route Codex takes names its base URL in argv: OpenAI's from
   * OPENAI_BASE_URL (through openai_base_url or the bento-openai
   * provider), OpenRouter's and AI Gateway's through their
   * model_provider tables. Each provider reads its key from the
   * environment and sends it as a bearer token, which is where the
   * proxy looks for the run's token.
   */
  modelProxy: { keys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"] },

  /**
   * Codex 0.153 ignores OPENAI_API_KEY for its built in provider: with
   * only that set, it called api.openai.com with no Authorization header
   * at all ("Missing bearer"). CODEX_API_KEY is the variable `codex exec`
   * reads, so the stored key is handed over under that name.
   */
  env(input: BuildCommandInput): Record<string, string> {
    if (input.customProvider) return {};
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
      return [{ path: "~/.codex/config.toml", content: renderCodexConfig(servers) }];
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
      codexModelId(input),
    );
    if (input.customProvider) {
      cmd.push(...customProviderConfigOverrides(input.customProvider));
    } else if (vercelSelected(input.model)) {
      cmd.push(...vercelConfigOverrides(vercelCodexBaseUrl(input.credentials)));
    } else if (openRouterSelected(input.model)) {
      // OpenRouter is the selected provider: tell Codex to use that
      // model_provider. -c still applies when ~/.codex is mounted
      // read-only and the config file above was not written. Nested
      // keys create the provider table if it is missing.
      cmd.push(...openRouterConfigOverrides(openRouterBaseUrl(input.credentials)));
    } else if (input.credentials?.BENTO_PERSONAL_PROVIDER === "openai-codex") {
      cmd.push(...openAiKeyConfigOverrides(input.credentials.OPENAI_BASE_URL));
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

  /**
   * `codex app-server`: a mid-task message steers the running turn (see
   * codex-app-server.ts for what was verified and how). A run that
   * cannot hold one (see appliesTo) keeps `codex exec`.
   */
  live: {
    delivery: "steer",
    liveSinceRecord: true,
    interrupts: true,
    /**
     * Only when every profile argument is a config override. The
     * profile's extra args were written for `codex exec`, and an exec
     * flag (`--search`, `--oss`) passed to app-server stops it at argv
     * parsing; such a profile keeps the one-shot command.
     */
    appliesTo: (input) => configOnlyArgs(input.extraArgs ?? []),
    buildCommand(input: BuildCommandInput): string[] {
      const cmd = ["codex", "app-server", "-c", `model=${tomlString(codexModelId(input))}`];
      if (input.customProvider) {
        cmd.push(...customProviderConfigOverrides(input.customProvider));
      } else if (vercelSelected(input.model)) {
        cmd.push(...vercelConfigOverrides(vercelCodexBaseUrl(input.credentials)));
      } else if (openRouterSelected(input.model)) {
        cmd.push(...openRouterConfigOverrides(openRouterBaseUrl(input.credentials)));
      } else if (input.credentials?.OPENAI_API_KEY) {
        /**
         * The app-server's built-in OpenAI provider reads neither
         * CODEX_API_KEY nor OPENAI_API_KEY (verified on 0.163.0: no
         * Authorization header with either set), and logging in over
         * the protocol writes the key into ~/.codex/auth.json. So a
         * saved key gets a provider of its own that reads CODEX_API_KEY,
         * which env() already sets: the key stays in the environment,
         * where `codex exec` keeps it, and never reaches a file.
         * Without a saved key (a shared login in local mode) the
         * built-in provider and its auth.json are left as they are.
         */
        cmd.push(...openAiKeyConfigOverrides(input.credentials.OPENAI_BASE_URL));
      } else if (input.credentials?.OPENAI_BASE_URL) {
        cmd.push("-c", `openai_base_url=${tomlString(input.credentials.OPENAI_BASE_URL)}`);
      }
      /**
       * Where a person can answer, request_user_input works outside Plan
       * mode too. The feature is Codex's "under development" one, so it
       * is on only for those runs.
       */
      if (input.askUser) cmd.push("--enable", "default_mode_request_user_input");
      if (input.extraArgs?.length) cmd.push(...input.extraArgs);
      return cmd;
    },
    connect: (input, how) => codexAppServerProtocol(input, how, { model: codexModelId(input) }),
  },

  parseDelta(line: string): Pick<AgentDelta, "channel" | "text"> | null {
    if (!line.includes('"method"')) return null;
    const message = readRpcLine(line);
    return message?.kind === "notification" ? parseAppServerDelta(message.method, message.params) : null;
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
    // A live session's notification (app-server); `codex exec --json`
    // lines carry a `type` instead.
    if (typeof parsed.method === "string") return parseAppServerEvent(parsed.method, parsed.params);

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
        /*
         * Codex prints what it used and never what it cost, which is
         * the case the estimated tier exists for. The counts are
         * carried through as counts: pricing them needs a rate card,
         * and the ledger is where that lives.
         */
        if (typeof parsed.usage?.input_tokens === "number") ev.inputTokens = parsed.usage.input_tokens;
        if (typeof parsed.usage?.output_tokens === "number") ev.outputTokens = parsed.usage.output_tokens;
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
    /*
     * Summed across every turn rather than taken from the last one: a
     * resumed thread reports per turn, and the run's bill is all of
     * them. Only the result events carry counts, so this is the same
     * list the outcome is read from.
     */
    const counted = events.filter((event) => event.type === "result");
    const inputTokens = sumTokens(counted.map((event) => event.inputTokens));
    const outputTokens = sumTokens(counted.map((event) => event.outputTokens));
    if (inputTokens !== undefined) outcome.inputTokens = inputTokens;
    if (outputTokens !== undefined) outcome.outputTokens = outputTokens;
    if (!outcome.ok) outcome.error = result.error ?? `exit code ${exitCode}`;
    return outcome;
  },
};

/**
 * Adds up the counts that are there, and answers nothing when none is.
 *
 * Zero would be a claim that the run used no tokens, which would then
 * be priced at nothing and recorded as a measured looking $0.00. A run
 * whose counts never arrived has to fall through to the assumed tier
 * instead, and "nothing" is how it says so.
 */
function sumTokens(counts: (number | undefined)[]): number | undefined {
  const known = counts.filter((count): count is number => typeof count === "number" && Number.isFinite(count));
  return known.length === 0 ? undefined : known.reduce((total, count) => total + count, 0);
}

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

/** The model id Codex is given, whichever route the profile selected. */
function codexModelId(input: BuildCommandInput): string {
  return input.customProvider?.modelId ?? (vercelSelected(input.model) ? input.model.slice("vercel/".length) : input.model);
}

/**
 * Whether a profile's extra args are all config overrides, which
 * `codex app-server` takes exactly as `codex exec` does.
 */
function configOnlyArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^(--config|--enable|--disable)=/.test(arg)) continue;
    if (arg === "-c" || arg === "--config" || arg === "--enable" || arg === "--disable") {
      if (i + 1 >= args.length) return false;
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** OpenAI through a provider that reads the key from CODEX_API_KEY; see the live command. */
function openAiKeyConfigOverrides(baseUrl: string | undefined): string[] {
  return [
    "-c", 'model_provider="bento-openai"',
    "-c", 'model_providers.bento-openai.name="OpenAI"',
    "-c", `model_providers.bento-openai.base_url=${tomlString(baseUrl || "https://api.openai.com/v1")}`,
    "-c", 'model_providers.bento-openai.env_key="CODEX_API_KEY"',
    "-c", 'model_providers.bento-openai.wire_api="responses"',
  ];
}

function vercelSelected(model: string): boolean {
  // The prefix is the selection. Do not ask providerForProfile: a
  // slash on Codex is otherwise OpenRouter, and that answer is what
  // this prefix exists to override.
  return model.startsWith("vercel/");
}

function openRouterConfigOverrides(baseUrl: string): string[] {
  return [
    "-c",
    'model_provider="openrouter"',
    "-c",
    'model_providers.openrouter.name="OpenRouter"',
    "-c",
    `model_providers.openrouter.base_url=${tomlString(baseUrl)}`,
    "-c",
    'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    "-c",
    'model_providers.openrouter.wire_api="responses"',
  ];
}

function vercelConfigOverrides(baseUrl: string): string[] {
  return [
    "-c",
    'model_provider="vercel"',
    "-c",
    'model_providers.vercel.name="Vercel AI Gateway"',
    "-c",
    `model_providers.vercel.base_url=${tomlString(baseUrl)}`,
    "-c",
    'model_providers.vercel.env_key="AI_GATEWAY_API_KEY"',
    "-c",
    'model_providers.vercel.wire_api="responses"',
  ];
}

function customProviderConfigOverrides(provider: NonNullable<BuildCommandInput["customProvider"]>): string[] {
  const id = provider.slug;
  return [
    "-c", `model_provider=${tomlString(id)}`,
    "-c", `model_providers.${id}.name=${tomlString(provider.name)}`,
    "-c", `model_providers.${id}.base_url=${tomlString(provider.baseUrl)}`,
    "-c", `model_providers.${id}.env_key="BENTO_CUSTOM_PROVIDER_API_KEY"`,
    "-c", `model_providers.${id}.wire_api="responses"`,
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
