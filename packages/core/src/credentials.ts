/**
 * Credentials an organization can store for its agents.
 *
 * Each organization brings its own keys: nothing here is ever supplied
 * by the server, so a hosted deployment never puts the operator's
 * credentials inside a tenant's sandbox.
 *
 * OpenRouter is supported the way it actually works, by pointing a
 * provider's base URL at it rather than being a separate CLI. Store the
 * OpenRouter key plus the matching base URL and any adapter that speaks
 * that provider's API will route through it.
 */
export interface AgentCredential {
  name: string;
  label: string;
  /** Shown under the field so people know which value belongs here. */
  help: string;
  /** Secret values are masked; base URLs are not sensitive. */
  secret: boolean;
}

export const AGENT_CREDENTIALS: readonly AgentCredential[] = [
  {
    name: "ANTHROPIC_API_KEY",
    label: "Anthropic (Claude Code)",
    help: "Used by Claude Code, and by opencode or pi when running Claude models.",
    secret: true,
  },
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude subscription token",
    help: "Lets Claude Code run on a Claude subscription instead of an API key. Mint one in a terminal with: claude setup-token. Saved here it survives server restarts and replaces any token from the environment. The console offers this in local mode only: credentials are stored one value per organization, so on a hosted deployment it would put one member's personal subscription behind every other member's runs.",
    secret: true,
  },
  {
    name: "OPENAI_API_KEY",
    label: "OpenAI (Codex)",
    help: "Used by the Codex CLI, and by opencode or pi when running OpenAI models.",
    secret: true,
  },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    help: "Used by opencode and pi directly. To send Claude Code or Codex through OpenRouter, also set that provider's base URL to https://openrouter.ai/api/v1.",
    secret: true,
  },
  {
    name: "GEMINI_API_KEY",
    label: "Google Gemini",
    help: "Used by opencode and pi when running Gemini models.",
    secret: true,
  },
  {
    name: "CURSOR_API_KEY",
    label: "Cursor",
    help: "Used by the Cursor CLI, whichever model it runs. Composer, Grok, Claude and GPT are all billed through your Cursor plan, so none of them needs that company's own key.",
    secret: true,
  },
  {
    name: "GITHUB_TOKEN",
    label: "GitHub token (pull requests)",
    help: "Lets stages with Create a pull request enabled push the feature branch and open the pull request, without installing the GitHub App. Use a fine grained personal access token with contents and pull request write access. It stays on the server and is never given to an agent.",
    secret: true,
  },
  {
    name: "ANTHROPIC_BASE_URL",
    label: "Anthropic base URL",
    help: "Point Claude Code somewhere else, for example https://openrouter.ai/api/v1 to bill through OpenRouter.",
    secret: false,
  },
  {
    name: "OPENAI_BASE_URL",
    label: "OpenAI base URL",
    help: "Point Codex somewhere else, for example https://openrouter.ai/api/v1.",
    secret: false,
  },
];

export const AGENT_CREDENTIAL_NAMES = AGENT_CREDENTIALS.map((c) => c.name);

/**
 * How each tool names a model, and what a valid string looks like.
 *
 * The tools disagree: the single provider ones take a bare model id,
 * while the provider agnostic ones take provider/model, which is also
 * how they are pointed at OpenRouter. Nothing validates these, because
 * the list of models changes faster than this file could; they are
 * guidance for the field, not a whitelist.
 */
export interface ModelGuidance {
  cli: string;
  /** How the tool is named to a person choosing one. */
  label: string;
  /** Offered when a tool is picked, so setup can proceed on Enter. */
  defaultModel: string;
  /** Shown under the model field. */
  format: string;
  /** Illustrative, not exhaustive. Confirm ids with your provider. */
  examples: readonly string[];
  /**
   * The executable a sandbox needs for this tool. Used to tell someone
   * choosing a tool whether their machine can actually run it, which is
   * otherwise discovered at the end of a queued run.
   */
  binary: string;
  /** Where its own project explains installing it. */
  installUrl: string;
  /** The one line install, for a person who is already in a terminal. */
  installCommand: string;
}

export const MODEL_GUIDANCE: readonly ModelGuidance[] = [
  {
    cli: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-sonnet-5",
    format: "A model id. Route through OpenRouter by also setting ANTHROPIC_BASE_URL.",
    examples: ["claude-sonnet-5", "claude-opus-5"],
    binary: "claude",
    installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  {
    cli: "codex",
    label: "Codex CLI",
    defaultModel: "gpt-5-codex",
    format: "A model id. Route through OpenRouter by also setting OPENAI_BASE_URL.",
    examples: ["gpt-5-codex", "gpt-5"],
    binary: "codex",
    installUrl: "https://github.com/openai/codex",
    installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
  {
    cli: "cursor",
    label: "Cursor CLI",
    defaultModel: "claude-sonnet-5",
    format:
      "A model id supported by your Cursor plan. Cursor bills all of them, so Composer and Grok need no key of their own.",
    examples: ["claude-sonnet-5", "composer-2.5", "grok-4.5", "auto"],
    binary: "cursor-agent",
    installUrl: "https://cursor.com/cli",
    installCommand: "curl -fsS https://cursor.com/install | bash",
  },
  {
    cli: "opencode",
    label: "opencode",
    defaultModel: "anthropic/claude-sonnet-5",
    format:
      "provider/model. Prefix with openrouter/ to route through OpenRouter, or use openrouter/openrouter/auto to let it pick per request.",
    examples: ["anthropic/claude-sonnet-5", "openrouter/z-ai/glm-4.6", "openrouter/openrouter/auto"],
    binary: "opencode",
    installUrl: "https://opencode.ai/docs/",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    cli: "pi",
    label: "pi",
    defaultModel: "anthropic/claude-sonnet-5",
    format:
      "provider/model, optionally with :thinking. Prefix with openrouter/ for OpenRouter, or use openrouter/openrouter/auto to let it pick per request.",
    examples: ["anthropic/claude-sonnet-5", "openrouter/z-ai/glm-4.6", "openrouter/openrouter/auto"],
    binary: "pi",
    installUrl: "https://github.com/earendil-works/pi",
    installCommand: "npm install -g @earendil-works/pi-coding-agent",
  },
  {
    cli: "fake",
    label: "Fake agent (for testing)",
    defaultModel: "fake-1",
    format: "Any value; the fake agent ignores it.",
    examples: ["fake-1"],
    binary: "sh",
    installUrl: "https://github.com/",
    installCommand: "true",
  },
];

/**
 * Whether a tool tells us what a run cost.
 *
 * Bento does not price anything itself: it records the figure the CLI
 * prints, and most do not print one. A total that silently omits three
 * of the five tools would read as a cheap pipeline rather than an
 * unmeasured one, so anywhere spend is shown, this decides whether to
 * say the number is partial.
 */
export function reportsCost(cli: string): boolean {
  return cli === "claude-code" || cli === "pi" || cli === "fake";
}

/**
 * Which tools print what a run cost, in words.
 *
 * Derived from the catalog rather than written out, because a spend
 * figure that names the wrong tools is worse than one that names none:
 * it tells somebody their Codex runs are counted when they are not.
 * The fake agent is left out; it is a test fixture, not a choice
 * anybody makes.
 */
function toolNames(reporting: boolean): string[] {
  return MODEL_GUIDANCE.filter((tool) => tool.cli !== "fake" && reportsCost(tool.cli) === reporting).map(
    (tool) => tool.label,
  );
}

/** "Claude Code and pi", "Codex CLI, Cursor CLI and opencode". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The sentence that has to accompany any spend figure Bento shows.
 * Most tools report nothing, so every total is a floor.
 */
export function spendCoverageNote(): string {
  const reporting = joinNames(toolNames(true));
  const silent = joinNames(toolNames(false));
  return `Only ${reporting} report what a run cost, and ${silent} report none. A run that fails before finishing reports nothing either, whichever tool it used. Any figure here is a floor rather than a full total.`;
}

export function modelGuidanceFor(cli: string): ModelGuidance | undefined {
  return MODEL_GUIDANCE.find((g) => g.cli === cli);
}
