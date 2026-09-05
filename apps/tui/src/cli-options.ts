import { parseArgs } from "node:util";
import os from "node:os";
import path from "node:path";

/**
 * Where the board data lives, and where agents run. These are separate
 * choices, which is what gives the three useful combinations:
 *
 *   client  server data,  server agents   thin client
 *   runner  server data,  local agents    shared board, your machine does the work
 *   local   local data,   local agents    everything on this machine
 */
export type Mode = "client" | "runner" | "local";

/** A subcommand, or the interactive board when none is given. */
export type Command = "board" | "serve" | "runner" | "login" | "setup" | "repos" | "agents" | "pipeline" | "spend" | "sessions" | "mcp";

export interface CliOptions {
  command: Command;
  mode: Mode;
  /** Server URL. Set for client and runner modes. */
  server?: string;
  /** Sandbox driver used wherever agents run locally. */
  sandbox: "docker" | "local-process";
  /** Database URL for local mode. Absent means "manage one with Docker". */
  db?: string;
  dataDir: string;
  port: number;
  /** Share this machine's agent logins with sandboxes. */
  shareAgentAuth: boolean;
  /** Identifies this machine when claiming work in runner mode. */
  runnerId: string;
  /** Which project a command acts on, by name or id. */
  project?: string;
  /** Bare words after a subcommand: the action, then its subject. */
  positionals: string[];
  /** Coding tool for `agents add` and `agents edit`. */
  tool?: string;
  skill?: string;
  /**
   * A repository's own toolchain and its check, for `repos add` and
   * `repos set`. Empty string clears one, which is why these are
   * distinguished from absent rather than falsy.
   */
  setupCommand?: string;
  testCommand?: string;
  /** Model for `agents add` and `agents edit`. */
  model?: string;
  /** New name for `agents edit`. */
  agentName?: string;
  /** MCP server URL for `mcp add`. */
  url?: string;
  /** MCP API key for `mcp add`. */
  mcpKey?: string;
  /** Silence the local stack's startup progress, for scripts. */
  quiet: boolean;
  help: boolean;
  version: boolean;
}

export const HELP = `bento - command centre for coordinating AI coding agents

Usage
  bento                                    Run everything on this machine
  bento --server <url>                     Use a server for both data and agents
  bento --server <url> --run-agents local  Use a server for data, run agents here

Commands
  setup                Connect repositories, add coding agents, assign them to
                       stages, and save provider keys. Everything a board needs
                       before agents can work, in one screen you can reopen.
  serve                Run the stack with no terminal UI and print its URL.
                       Used by the desktop app, or to keep a local server up.
  runner --server <url>
                       Execute agent runs this server holds for this machine,
                       with no terminal UI.
  login --server <url>
                       Sign this machine in. Used by the desktop app; the login
                       is shared with the other commands.
  repos [list]         Repositories the project spans, one per line.
  repos add <path> [--setup <cmd>] [--test <cmd>]
                       Add a checkout. A card's workspace then holds a
                       worktree of each, side by side, so a change across
                       two of them is still one card.
  repos set <name> [--setup <cmd>] [--test <cmd>]
                       Change what a repository installs and how its work
                       is checked. Pass an empty string to clear one.
  repos remove <name>  Remove one. A project keeps at least one.
  agents [list]        Coding agents, one per line: name, tool, model, skill.
  agents add <name> --tool <cli> --model <model> [--skill <text>]
                       Pair a tool with a model.
  agents edit <name> [--name <new>] [--tool <cli>] [--model <model>] [--skill <text>]
                       Change one in place. Every stage using it follows,
                       which deleting and re-adding would not do.
  agents remove <name> Remove one.
  agents export [file] Write every named agent as YAML: the tool, the
                       model, and the skill. Prints to stdout with no file.
  agents import <file> Apply one. Agents are matched by name, so importing
                       twice edits rather than duplicating.
  pipeline export [file]
                       Write the whole pipeline as YAML: its stages, their
                       requirements, the agents that run them, and each
                       repository's commands. Prints to stdout with no file.
  pipeline import <file>
                       Apply one. Stages are matched by slug and updated in
                       place, so a live board keeps its cards where they are.
  spend                Agent spend for the project, one line per card.
  sessions             Conversations in the project, newest activity first.
  mcp [list]           MCP servers agents can call, one per line.
  mcp add <name> --url <url> [--key <value>]
                       Add a custom server. Pass --key for API key auth.
                       OAuth servers are connected in the web console.
  mcp remove <name>    Remove one.

Options
  --server <url>       Server holding your organization, projects, and history.
                       Without it, bento runs its own server on this machine.
  --run-agents <where> Where agents run: local or server.
                       Defaults to local without --server, server with it.
  --sandbox <driver>   How local agents are isolated: docker (default) or
                       local-process. local-process gives agents no isolation,
                       so use it only for development.
  --db <url>           Postgres for local data. Without this, bento manages its
                       own Postgres container.
  --data-dir <path>    Where worktrees and state live (default ~/.bento)
  --port <number>      Port for the local server (default: any free port)
  --share-agent-auth   Let agents use the Claude, Codex, Cursor, opencode
                       or pi login already on this machine, instead of an
                       API key. Only for agents running locally. These are
                       long lived credentials for a paid account, and an
                       agent can read anything its sandbox can, so only use
                       this on repositories you trust.
  --runner-id <name>   Name this machine reports when claiming work
                       (default: this computer's hostname)
  --project <name>     Project a command acts on, by name or id. Only needed
                       when there is more than one.
  --setup <cmd>        Shell run once in a fresh sandbox, before any agent
                       starts. Sandboxes carry git and the coding agents
                       and no language runtime, so this is where a
                       repository installs the toolchain it needs.
  --test <cmd>         Shell the agent is told to run to check its work.
  --skill <text>       The agent's operating instructions, sent with every
                       run. Define what its stage write-up must contain.
  --tool <cli>         Coding tool for an agent: claude-code, codex, cursor,
                       opencode, pi, pool, dsh, antigravity.
  --model <model>      Model for an agent.
  --name <name>        New name, when editing an agent.
  --url <url>          MCP server URL, for mcp add.
  --key <value>        MCP API key, for mcp add.
  --quiet              Drop the startup progress lines from repos and agents
                       commands, for scripts that only want the output.
  -h, --help           Show this message
  -V, --version        Print the version

Environment
  BENTO_URL              Same as --server

Examples
  bento
      Everything here: your own database, board, and agents in containers.

  bento --server https://bento.example.com
      Thin client. Your team's board, and agents run on the server.

  bento --server https://bento.example.com --run-agents local
      Shared board, but agents run in containers on this machine against
      your local checkouts. Your code and agent keys stay here.

  bento repos add ../api --project Checkout
      Make the project span a second repository. Cards then get a
      worktree of each.

  bento pipeline export team-pipeline.yaml
      Keep the pipeline beside the code it describes, and import it into
      the next project rather than clicking it together again.

  bento agents export team-agents.yaml
      Keep the named agents beside the code they work in, and import them
      into the next install rather than pairing them again.
`;

export function parseCliOptions(argv: string[]): CliOptions {
  // A leading bare word is the subcommand; everything else is flags.
  let command: Command = "board";
  let args = argv;
  const first = argv[0];
  if (first && !first.startsWith("-")) {
    if (
      first !== "serve" &&
      first !== "runner" &&
      first !== "login" &&
      first !== "setup" &&
      first !== "repos" &&
      first !== "pipeline" &&
      first !== "agents" &&
      first !== "spend" &&
      first !== "sessions" &&
      first !== "mcp"
    ) {
      throw new Error(
        `unknown command "${first}". Use setup, serve, runner, login, repos, pipeline, agents, spend, sessions, or mcp, or no command for the board.`,
      );
    }
    command = first;
    args = argv.slice(1);
  }

  // `repos` and `agents` take bare words after the subcommand. They are
  // consumed before flag parsing so a path or a name starting with "-"
  // cannot be read as a flag.
  const positionals: string[] = [];
  if (command === "repos" || command === "agents" || command === "pipeline" || command === "mcp") {
    while (args[0] && !args[0].startsWith("-")) {
      positionals.push(args[0]);
      args = args.slice(1);
    }
  }

  const { values } = parseArgs({
    args,
    options: {
      server: { type: "string" },
      "run-agents": { type: "string" },
      // The old spelling, kept working but no longer documented: it sat
      // next to the `agents` subcommand and read as being about it,
      // when it decides where runs execute.
      agents: { type: "string" },
      sandbox: { type: "string" },
      db: { type: "string" },
      "data-dir": { type: "string" },
      port: { type: "string" },
      "runner-id": { type: "string" },
      project: { type: "string" },
      tool: { type: "string" },
      model: { type: "string" },
      name: { type: "string" },
      "share-agent-auth": { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      skill: { type: "string" },
      setup: { type: "string" },
      test: { type: "string" },
      url: { type: "string" },
      key: { type: "string" },
    },
    allowPositionals: false,
  });

  const sandbox = values.sandbox ?? "docker";
  if (sandbox !== "docker" && sandbox !== "local-process") {
    throw new Error(`--sandbox must be "docker" or "local-process", not "${sandbox}"`);
  }

  const server = values.server ?? process.env.BENTO_URL;
  const agents = values["run-agents"] ?? values.agents ?? (server ? "server" : "local");
  if (agents !== "local" && agents !== "server") {
    throw new Error(`--run-agents must be "local" or "server", not "${agents}"`);
  }
  if (!server && agents === "server") {
    throw new Error("--run-agents server needs --server <url>: there is no server to run them on otherwise");
  }
  if (command === "runner" && !server) {
    throw new Error("runner needs --server <url>: it executes work that a server is holding");
  }
  if (command === "login" && !server) {
    throw new Error("login needs --server <url>: there is nothing to sign in to otherwise");
  }

  const port = values.port ? Number(values.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a port number, not "${values.port}"`);
  }

  const mode: Mode = !server ? "local" : agents === "local" ? "runner" : "client";

  return {
    command,
    mode: command === "runner" ? "runner" : mode,
    ...(server ? { server } : {}),
    sandbox,
    ...(values.db ? { db: values.db } : {}),
    dataDir: values["data-dir"] ?? path.join(os.homedir(), ".bento"),
    port,
    shareAgentAuth: values["share-agent-auth"] ?? false,
    runnerId: values["runner-id"] ?? os.hostname(),
    ...(values.project ? { project: values.project } : {}),
    ...(values.tool ? { tool: values.tool } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.skill !== undefined ? { skill: values.skill } : {}),
    ...(values.setup !== undefined ? { setupCommand: values.setup } : {}),
    ...(values.test !== undefined ? { testCommand: values.test } : {}),
    ...(values.name ? { agentName: values.name } : {}),
    ...(values.url ? { url: values.url } : {}),
    ...(values.key ? { mcpKey: values.key } : {}),
    positionals,
    quiet: values.quiet ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

/** One line describing the active setup, shown in the TUI header. */
export function describeMode(options: CliOptions, sandbox?: string): string {
  const driver = sandbox ?? options.sandbox;
  switch (options.mode) {
    case "local":
      return `local · agents in ${driver}`;
    case "runner":
      return `${options.server} · agents here in ${driver}`;
    case "client":
      return `${options.server} · agents on server`;
  }
}
