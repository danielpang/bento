import type { AgentCli, AgentDelta, AgentEvent, CustomProviderProtocol, RunOutcome } from "@bento/core";
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
  /** A Bento-owned provider selected for this run. The API key stays in env. */
  customProvider?: CustomProviderSelection;
  /**
   * A person can answer the agent's questions on this run, so a tool
   * that can ask (Claude Code's AskUserQuestion) is let to. Off for
   * every run nobody can answer, where the tool stays disabled.
   */
  askUser?: boolean;
}

export interface CustomProviderSelection {
  slug: string;
  name: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  modelId: string;
  models: { id: string; name: string }[];
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
 *
 * A tool speaks one of two shapes, and declares exactly one of
 * `encodeMessage` and `connect`. A tool that reads one JSON line per
 * user message and needs nothing back declares `encodeMessage`, the
 * whole protocol. Codex (`codex app-server`) and opencode (`opencode
 * acp`) are JSON-RPC servers on stdio: a message names a thread or
 * session id the process handed out earlier, and the process sends
 * requests of its own that must be answered. Claude Code and pi send
 * lines as messages too, but ask questions that wait for an answer
 * (Claude Code's control requests, pi's extension dialogs). Those need
 * state or replies, which is what `connect` returns.
 */
export interface LiveSession {
  delivery: "steer" | "queue";
  /**
   * Whether this particular run should hold a live session. Absent
   * means always. The fake agent keys off the prompt so its scripted
   * one-shot behaviors (SLOW, FAIL) stay available to tests.
   */
  appliesTo?(input: BuildCommandInput): boolean;
  /**
   * Live mode on this tool arrived with `agent_runs.live_session`, the
   * record a reattach reads. A run whose row has no record (one from
   * before that column) ran the one-shot command, so a reattach to it
   * must not go live.
   */
  liveSinceRecord?: boolean;
  /**
   * The tool can stop the turn in progress and keep the session open
   * (LiveProtocol.interrupt), so a person can redirect it without
   * ending the run.
   */
  interrupts?: boolean;
  /** argv for a session that reads user messages on stdin. */
  buildCommand(input: BuildCommandInput): string[];
  /** One stdin line delivering the opening prompt or a follow-up. */
  encodeMessage?(text: string, kind: "initial" | "followUp"): string;
  /**
   * A conversation with one process, for tools whose live mode is a
   * protocol rather than a line per message. `attach` is true when the
   * process is already running (a server reattaching after a restart),
   * so the protocol must not repeat its handshake and takes the
   * session id from `input.resumeSessionId`.
   */
  connect?(input: BuildCommandInput, how: { attach: boolean }): LiveProtocol;
}

/**
 * One live process's side of a stdio protocol.
 *
 * Every method returns the stdin lines to write, so the protocol never
 * holds the channel itself: the executor writes them, and a channel
 * that has closed refuses them the same way it refuses any other line.
 */
export interface LiveProtocol {
  /**
   * The first lines: the handshake, then the opening prompt when there
   * is one. The prompt may be held until the handshake answers (a
   * thread id the first turn has to name), and goes out from `read`.
   */
  open(prompt: string | null): string[];
  /**
   * A message from a person. Lines to write now; a message that cannot
   * go out yet is held and released by `read`, and counts in `held`.
   * Null when this process will never take it (its handshake failed),
   * so the caller puts the message back for the next run.
   */
  send(text: string): string[] | null;
  /**
   * Every stdout line, before it is parsed. `write` answers the process
   * (a response to its request, a held message now that it can go).
   * `events`, when present, replace what parseEvent would make of the
   * line, for the facts only a protocol with memory can state: a turn's
   * end with the usage reported lines earlier, or a message assembled
   * from its fragments.
   */
  read(line: string): {
    write: string[];
    events?: AgentEvent[];
    /** Questions the process just asked; see LiveAsk. */
    asks?: LiveAsk[];
    /** Ids of questions the process withdrew (its turn was interrupted, or it gave up waiting). */
    withdrawn?: string[];
  };
  /** Messages accepted by `send` or `open` and not written yet. */
  readonly held: number;
  /**
   * Stops the turn in progress without ending the process, for a tool
   * that can. The turn then ends with a result marked `interrupted`,
   * and the session waits for the next message.
   *
   * The lines to write now. Empty when a turn was asked for and has not
   * announced itself yet: the protocol sends the interrupt from `read`
   * as it does. Null when there is no turn this process can name (none
   * running, or one that started before this process attached).
   */
  interrupt?(): string[] | null;
  /** The lines that answer a question this process asked (`read` reported it in `asks`). */
  answer?(ask: LiveAsk, answers: Record<string, string>): string[];
  /** The lines that tell the process nobody will answer, with the reason it is given instead. */
  decline?(ask: LiveAsk, reason: string): string[];
}

/** One multiple choice question an agent put to a person. */
export interface AskQuestion {
  question: string;
  /** A short label for the question, a few words at most. */
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/**
 * Questions the process is blocked on until somebody answers. `id` is
 * the process's own request id, which the answer has to echo; `input`
 * is the tool input as the process sent it, which the answer carries
 * back. Both are stored, so an answer can be written by a process that
 * reattached after the question was asked.
 */
export interface LiveAsk {
  id: string;
  questions: AskQuestion[];
  input: unknown;
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
   * The CLI-native ids carried by a persisted event, used to tell
   * delivered messages from missed ones, and, when a server reattaches
   * to a running agent, to drop what the sandbox replays of a
   * transcript it already has. Applies to both streamed events and
   * previously recovered ones, so recovery is idempotent. Assistant
   * messages must carry one; tool events may, and an adapter that
   * names them protects its reattached runs from replayed tool lines
   * too. Empty for events that carry no usable identity; those are
   * never recovered against or dropped, because without an id
   * "missing" and "already there" cannot be told apart.
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

/** A file to write into the sandbox: an absolute path, or `~/` for the sandbox user's home. */
export interface McpFile {
  path: string;
  content: string;
}

/** One POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** True for `~` and `~/...`. */
export function isSandboxHomePath(path: string): boolean {
  return path === "~" || path.startsWith("~/");
}

/** Shell expression for the path; `~/` expands to `"${HOME:-/root}"` where the command runs. */
export function sandboxPathExpression(path: string): string {
  if (path === "~") return '"${HOME:-/root}"';
  if (path.startsWith("~/")) return `"\${HOME:-/root}"${shellQuote(path.slice(1))}`;
  return shellQuote(path);
}

/** `~` replaced by a known home. */
export function resolveSandboxPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
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
    vercel: "AI_GATEWAY_API_KEY",
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
  const dir = sandboxPathExpression(file.path.replace(/\/[^/]+$/, "") || "/");
  const path = sandboxPathExpression(file.path);
  return ["sh", "-c", `if [ ! -d ${dir} ]; then mkdir -p ${dir} && chmod 700 ${dir}; fi && printf %s ${shellQuote(file.content)} > ${path} && chmod 600 ${path}`];
}
