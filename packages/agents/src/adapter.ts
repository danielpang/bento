import type { AgentCli, AgentDelta, AgentEvent, RunOutcome } from "@bento/core";
import { hasOllamaCredentials, OLLAMA_CREDENTIAL_NAMES, ollamaNeedsSavedCredentials, routesToOllama } from "@bento/core";

export interface BuildCommandInput {
  prompt: string;
  model: string;
  /** Working directory inside the sandbox. */
  cwd: string;
  resumeSessionId?: string;
  extraArgs?: string[];
  /**
   * The credentials resolved for this run, under the names Bento stores
   * them by. For tools that want a stored value under another name or as
   * a flag: Codex reads neither OPENAI_API_KEY nor OPENAI_BASE_URL any
   * more. Only base URLs may be copied into argv, which a process
   * listing shows to anything else in the sandbox; keys travel through
   * the env hook.
   */
  credentials?: Readonly<Record<string, string>>;
}

/**
 * Maps one agent CLI onto the normalized run lifecycle.
 * Adapters never spawn processes themselves; the orchestrator runs the
 * command through a SandboxDriver and feeds stdout lines to parseEvent.
 */
/**
 * A live conversation with a working agent, over the process's stdin.
 *
 * Tools differ in what a mid-task message means, and the difference is
 * user-visible, so it is declared rather than papered over:
 * "steer" reaches the agent while it works (pi delivers after the
 * current tool call); "queue" waits for the current turn to finish
 * (Claude Code processes stdin messages sequentially). Tools without
 * this capability fall back to queue-and-resume between runs.
 */
export interface LiveSession {
  delivery: "steer" | "queue";
  /**
   * Whether this particular run should hold a live session. Absent
   * means always. The fake agent keys off the prompt so its scripted
   * one-shot behaviors (SLOW, FAIL) stay available to tests.
   */
  appliesTo?(input: BuildCommandInput): boolean;
  /** argv for a session that reads user messages on stdin. */
  buildCommand(input: BuildCommandInput): string[];
  /** One stdin line delivering the opening prompt or a follow-up. */
  encodeMessage(text: string, kind: "initial" | "followUp"): string;
}

/**
 * One assistant message read back out of a CLI's own session record,
 * for transcripts with holes in them.
 */
export interface RecoveredMessage {
  text: string;
  /**
   * The event's raw payload, in the same shape this adapter's live
   * stream would have produced, so a recovered message is
   * indistinguishable from a delivered one everywhere downstream and
   * carries the ids that keep it from being recovered twice.
   */
  raw: unknown;
}

/**
 * Reads the conversation back out of the CLI's own session storage.
 *
 * The stream is not the only copy of what an agent said: every CLI
 * also writes its session to disk in the sandbox, and that record
 * survives the disconnects that eat the stream. When a server restart
 * cuts a run loose and the agent keeps working, the messages it
 * produces reach nobody; the next run that resumes the session uses
 * this to read them back and fill the hole in the transcript.
 *
 * Optional because it needs a documented, stable way to get the
 * session back out of the tool. Adapters without it lose detached
 * messages the way they always did.
 */
export interface SessionRecovery {
  /**
   * argv that prints the session's record to stdout inside the
   * sandbox. cwd is where the agent ran, for tools that key their
   * storage on the project directory. A non-zero exit means "no
   * record", which callers treat as nothing to recover.
   */
  readLogCommand(sessionId: string, cwd: string): string[];
  /** The assistant messages the record holds, in conversation order. */
  parseLog(raw: string): RecoveredMessage[];
  /**
   * The CLI-native ids carried by a persisted assistant message event,
   * used to tell delivered messages from missed ones. Applies to both
   * streamed events and previously recovered ones, so recovery is
   * idempotent. Empty for events that carry no usable identity; those
   * are never recovered against, because without an id "missing" and
   * "already there" cannot be told apart.
   */
  persistedIds(event: AgentEvent): string[];
}

/**
 * One MCP server as a harness config sees it: the Bento gateway URL for
 * that server plus the run-scoped bearer token. Adapters never see the
 * upstream URL or any real credential; the gateway attaches those on
 * the server.
 */
export interface McpRemoteServer {
  slug: string;
  url: string;
  transport: "http" | "sse";
  headers: Record<string, string>;
}

/** A file to write into the sandbox, absolute path. */
export interface McpFile {
  path: string;
  content: string;
}

/**
 * How a harness consumes remote MCP servers. Feature-detected like
 * every other capability: a tool without it simply runs with no MCP
 * servers, and the transcript says so. renderConfig is called with an
 * empty list too, so a run after the last server was removed overwrites
 * yesterday's config instead of leaving it behind; sandboxes are per
 * feature and outlive runs.
 */
export interface McpCapability {
  /** Files written into the sandbox before the agent starts, every run. */
  renderConfig(servers: McpRemoteServer[]): McpFile[];
  /** argv appended after profile extraArgs when at least one server attached. */
  extraArgs?(): string[];
  /**
   * Extra sandbox env this config needs. fx is the case: it refuses a
   * literal Authorization header, so the run grant travels as
   * BENTO_MCP_GRANT and the file names that variable. Resume attach
   * inherits the process environment, so this is only read on the
   * first spawn.
   */
  env?(servers: McpRemoteServer[]): Record<string, string>;
}

export interface AgentAdapter {
  cli: AgentCli;
  /** Plain text is buffered into one message; absent means newline-delimited events. */
  stdoutMode?: "text";
  /** Env var names that must be present in the sandbox for this CLI. */
  /** Credentials the agent cannot run without. */
  requiredEnv: string[];
  /**
   * Credentials forwarded when the organization has them. Base URL
   * overrides live here, which is how a provider gets routed through
   * OpenRouter without a separate adapter.
   */
  optionalEnv?: string[];
  /**
   * Env var names that stand in for every requiredEnv entry: a login
   * token where requiredEnv names an API key. Any one of these present
   * means the agent can start. Listed separately from optionalEnv
   * because presence changes whether a run is allowed to begin, not
   * just what gets forwarded.
   */
  authAlternatives?: string[];
  /**
   * Home relative paths holding this tool's own login, so a local user
   * can run agents on a subscription they already pay for instead of a
   * separate API key. Only ever mounted in local mode, and only when
   * explicitly enabled: these are long lived credentials, and an agent
   * can read anything its sandbox can.
   */
  configPaths?: string[];
  /**
   * Credentials required for a specific model, for provider agnostic
   * tools: an openrouter/ model needs the OpenRouter key even though
   * the tool as a whole requires nothing. Overrides requiredEnv when
   * present. Without this, a keyless opencode run started fine and
   * died inside the tool with a generic server error.
   */
  requiredEnvFor?(model: string): string[];
  /**
   * Per-run environment this tool needs, for CLIs that take their
   * configuration as environment variables rather than flags. pool is
   * the case: `pool exec` has no --model, so the model travels as
   * POOLSIDE_STANDALONE_MODEL. Merged under the organization's stored
   * credentials, so a value saved there wins over the default here.
   *
   * Not folded into argv as an `env VAR=x` prefix, because argv[0] is
   * what names the binary in the "not installed" failure and in
   * spawn-failure detection.
   */
  env?(input: BuildCommandInput): Record<string, string>;
  /**
   * Files the tool needs in the sandbox before it starts, for settings it
   * takes only from a file. DeepSeek Harness is the case: the token limit
   * an Ollama model needs can only be lowered by a patch overlay. Written
   * before every run, because sandboxes outlive runs. Never secrets:
   * those travel through env.
   */
  files?(input: BuildCommandInput): McpFile[];
  /** Present when the tool can consume remote MCP servers. */
  mcp?: McpCapability;
  /** Present when the tool can hold a live stdin conversation. */
  live?: LiveSession;
  /** Present when the tool's session storage can be read back. */
  sessionRecovery?: SessionRecovery;
  buildCommand(input: BuildCommandInput): string[];
  /** Parse one stdout line. Return null for lines that are not events. */
  parseEvent(line: string): AgentEvent | null;
  /**
   * Recognize a streaming fragment of the message being composed, for
   * tools that emit per token updates. Consulted before parseEvent, so
   * a recognized delta line never reaches the transcript or the stray
   * output tail; it is forwarded live and then forgotten. The finished
   * message still arrives through parseEvent. Optional because most
   * CLIs only report whole messages. The offset is stamped by
   * runAgent, which sees the whole stream; adapters only name the
   * fragment.
   *
   * An empty text means "streaming chatter, nothing to forward": block
   * boundaries, signatures, tool argument fragments. They are consumed
   * so a failing run's stderr tail holds the actual reason instead of
   * a page of streaming JSON.
   */
  parseDelta?(line: string): Pick<AgentDelta, "channel" | "text"> | null;
  /** Decide success/failure from the collected events and exit code. */
  extractOutcome(events: AgentEvent[], exitCode: number): RunOutcome;
}

/**
 * The credential names a run needs for this model.
 *
 * requiredEnvFor replaces requiredEnv entirely: a Codex profile with
 * OpenRouter selected needs OPENROUTER_API_KEY and must not also
 * demand OPENAI_API_KEY. The hook is used when it exists, rather than
 * or-ing its return onto requiredEnv, so an empty list stays empty.
 */
export function requiredEnvForModel(
  adapter: Pick<AgentAdapter, "requiredEnv" | "requiredEnvFor">,
  model?: string,
): string[] {
  if (model && adapter.requiredEnvFor) return adapter.requiredEnvFor(model);
  return adapter.requiredEnv;
}

/** Names resolveAgentEnv forwards into the sandbox for this model. */
export function forwardedEnvNames(
  adapter: Pick<AgentAdapter, "requiredEnv" | "optionalEnv" | "authAlternatives" | "requiredEnvFor">,
  model?: string,
): string[] {
  return [
    ...requiredEnvForModel(adapter, model),
    ...(adapter.optionalEnv ?? []),
    ...(adapter.authAlternatives ?? []),
  ];
}

export function lastResultEvent(events: AgentEvent[]): Extract<AgentEvent, { type: "result" }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.type === "result") return ev;
  }
  return undefined;
}

/** The key a provider/model string needs, for provider agnostic tools. */
export function providerKeyFor(model: string): string[] {
  const byProvider: Record<string, string> = {
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    gemini: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
  };
  const key = byProvider[model.split("/")[0] ?? ""];
  return key ? [key] : [];
}

/**
 * How an ollama/ model decides where a run goes: always to Bento's
 * Ollama, only once Ollama credentials are saved (opencode, whose own
 * config can define an ollama provider), or never (a tool Bento does not
 * point at Ollama).
 */
export type OllamaRoute = "always" | "when-saved" | "never";

/**
 * Which credentials to look up for a run, for this tool and model.
 *
 * Claude Code and DeepSeek Harness on an ollama/ model want Ollama's
 * credentials and nothing else. opencode looks up both its own and
 * Ollama's, because which set the run keeps depends on what was saved:
 * see runsOnOllama.
 */
export function credentialNamesFor(
  adapter: Pick<AgentAdapter, "requiredEnv" | "optionalEnv" | "authAlternatives" | "requiredEnvFor"> & { cli?: string },
  model?: string,
): { required: string[]; optional: string[]; alternatives: string[]; ollama: OllamaRoute } {
  const own = {
    // requiredEnvFor replaces requiredEnv: an openrouter/ model needs the
    // OpenRouter key and nothing the tool requires in general.
    required: requiredEnvForModel(adapter, model),
    optional: adapter.optionalEnv ?? [],
    alternatives: adapter.authAlternatives ?? [],
  };
  if (!model || !adapter.cli || !routesToOllama(adapter.cli, model)) return { ...own, ollama: "never" };
  if (ollamaNeedsSavedCredentials(adapter.cli)) {
    return { ...own, optional: [...own.optional, ...OLLAMA_CREDENTIAL_NAMES], ollama: "when-saved" };
  }
  return { required: [], optional: [...OLLAMA_CREDENTIAL_NAMES], alternatives: [], ollama: "always" };
}

/**
 * Whether a run with the credentials found goes to Bento's Ollama. When
 * it does, it is given Ollama's credentials only and no shared login: an
 * Anthropic key or a Claude subscription token would otherwise be sent to
 * whatever server OLLAMA_BASE_URL names.
 */
export function runsOnOllama(names: { ollama: OllamaRoute }, found: Readonly<Record<string, string>>): boolean {
  return names.ollama === "always" || (names.ollama === "when-saved" && hasOllamaCredentials(found));
}

/**
 * argv that writes one file into a sandbox. The content rides argv,
 * single quoted, rather than exec env, which the sprite driver puts in
 * the exec URL.
 */
export function writeFileCommand(file: McpFile): string[] {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const dir = file.path.replace(/\/[^/]+$/, "") || "/";
  return ["sh", "-c", `mkdir -p ${quote(dir)} && printf %s ${quote(file.content)} > ${quote(file.path)}`];
}
