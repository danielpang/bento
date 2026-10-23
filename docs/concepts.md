<h1 align="center">How Bento works</h1>

A feature is a card that moves through pipeline stages. When a card enters a stage, that stage's agent runs in a sandbox with git worktrees of the project's repositories. Stages pass context through committed files under `docs/bento/<stage>.md`.

## Cards, sandboxes and worktrees

One card, one branch, one sandbox. The sandbox is created on the first agent run and reused for later stages on that card. Setup dependencies and caches from earlier runs remain available.

Hosted sandboxes outlive the server process. If the server restarts during a run, the sandbox continues and the server reattaches. What the agent said while no server was attached is read back from the CLI's own session record and appended to the transcript before live output resumes, and anything the sandbox replays of a transcript Bento already has is dropped by message id. A deploy neither loses nor repeats the conversation.

Follow-up messages resume the CLI session when the tool exposes a session id (Claude Code, Codex, Cursor, opencode, pi, Antigravity, Muse Code, fx). If the session is unavailable, Bento starts a new run with the stage prompt and a compacted transcript. See [agents.md](./agents.md#talking-to-a-working-agent) for per-tool behavior.

**Multi-repository projects.** Each repository gets a worktree under one feature workspace:

```
<data-dir>/worktrees/<featureId>/web
<data-dir>/worktrees/<featureId>/api
```

With one repository, the agent starts in that checkout. With several, it starts at the workspace root and the prompt lists each checkout. The first repository is primary: stage artifacts are written there, and project repository fields follow it.

## What a sandbox contains

Git, the seven coding agent CLIs, and no language runtime. Repository toolchains are installed via setup commands. See [pipeline.md](./pipeline.md#repository-commands).

Local deployments use Docker containers (default) or an in-process driver with no isolation. Hosted deployments use Fly Sprites. All drivers share one interface.

## Spend

Spend is recorded per card and per project when the tool reports it. Bento does not bill or enforce limits. Only Claude Code and pi report cost. Totals include a count of unmeasured runs; unmeasured runs are not treated as zero cost.

## Tenancy

Local mode: one user, no organizations, `organization_id` is null everywhere.

Multi mode: projects belong to an organization. All members of that organization see all of its projects. There is no per-project sharing.

Three isolation layers:

- Route checks re-read membership on every request.
- Row-level security confines queries to the caller's organization.
- Insert triggers derive `organization_id` from the parent row.

Table-level detail: [diagrams/database_schema.md](./diagrams/database_schema.md).

## Security

Agents read untrusted input (issues, READMEs, web pages, tool output), so Bento assumes any agent can be prompt injected. The sandbox is the boundary: an agent can run any command and read anything in its sandbox. What Bento controls is what the sandbox holds and what it can reach.

### What a sandbox holds

- **Model API keys.** In multi mode, the sandbox holds a run token in place of each key its tool can send through Bento's model proxy. Bento attaches the organization's key on the way to the provider. The token works only while its run is queued or running, and only for the provider's completion, token counting and model listing endpoints. Keys that cannot go through the proxy still reach the sandbox: see [agents.md](./agents.md#model-provider-keys-never-enter-a-hosted-sandbox) for which.
- **MCP credentials.** Never. The sandbox holds the same run token and Bento's gateway address for each server; the gateway attaches the server's credential. See [mcp.md](./mcp.md).
- **Git access.** On a hosted server, short lived GitHub App installation tokens, never the host's SSH keys or git config.
- **Local mode** has one trusted user: keys go to the agent directly, and shared subscription credentials are mounted read only, which the agent can still read.

### What a sandbox can reach

By default, the open internet, so agents can install packages and read docs.

An owner or admin can block that in **Settings, Team**. A blocked team's runs go to Modal, which allows only:

- Bento's own address, where the model proxy and the MCP gateway live
- the project's git remotes
- the hosts of model keys that are not proxied
- the team's **Allowed sites** (each team MCP server's host is added when it is enabled, and can be removed)

**Docker deployments.** With the lock on, Docker sandboxes use a network the operator creates (`BENTO_SANDBOX_RESTRICTED_NETWORK`), and Bento does not manage its rules. That network must let sandboxes reach Bento's address (`BENTO_MCP_GATEWAY_URL`, or `BETTER_AUTH_URL`; a `localhost` address is reached as `host.docker.internal`), because model calls go through the proxy there. Without that route, every locked run fails at its first model call. The Allowed sites list does not apply to Docker, and locked Docker runs attach no MCP servers. Setup: [web-app.md](./web-app.md#network-lock-on-docker).

### Good practice

- Never expose the host Docker socket, host SSH keys, or host git config to a sandbox.
- Prefer API keys over mounting subscription credential files.
- Keep a saved provider base URL on public `https`. A plain `http` or private base URL cannot go through the proxy, so its key stays in the sandbox.
