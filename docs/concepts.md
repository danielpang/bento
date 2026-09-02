# How Bento works

A feature is a card that moves through pipeline stages. When a card enters a stage, that stage's agent runs in a sandbox with git worktrees of the project's repositories. Stages pass context through committed files under `docs/bento/<stage>.md`.

## Cards, sandboxes and worktrees

One card, one branch, one sandbox. The sandbox is created on the first agent run and reused for later stages on that card. Setup dependencies and caches from earlier runs remain available.

Hosted sandboxes outlive the server process. If the server restarts during a run, the sandbox continues and the server reattaches.

Follow-up messages resume the CLI session when the tool exposes a session id (Claude Code, Codex, Cursor, opencode, pi). If the session is unavailable, Bento starts a new run with the stage prompt and a compacted transcript. See [agents.md](./agents.md#talking-to-a-working-agent) for per-tool behavior.

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
