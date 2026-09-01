# How it works

Each feature is a card that moves through your stages. When a card enters a stage, that stage's agent runs in a sandbox holding git worktrees of your repositories. Stages pass context to each other through committed artifact files (`docs/bento/<stage>.md`). That is how a card designed by one agent can be implemented by another.

## Cards, sandboxes and worktrees

One card, one branch, one sandbox. The sandbox is created when the card's first agent runs, and it outlives that run. The second stage therefore starts warm, with the setup command's dependencies and the first agent's caches still in place. Hosted sandboxes also outlive the server. A deploy during a run does not end it: the sandbox keeps the agent working through the disconnect, and the restarted server reattaches.

A follow-up message continues the same CLI session when the tool prints a session id. Claude Code, Codex, Cursor, opencode and pi all do. Tools that cannot resume, and sessions the sandbox no longer holds, start a fresh run with the stage prompt and a compacted transcript. pi and Claude Code also hold the process open for a short idle window after a turn on a manual stage, so you can keep talking without starting a new run.

**A project can span several repositories.** Each gets its own worktree inside one feature workspace, so a change touching a frontend and a backend is a single card:

```
<data-dir>/worktrees/<featureId>/web
<data-dir>/worktrees/<featureId>/api
```

With one repository the agent starts inside it. With several it starts at the workspace root and the prompt lists what is checked out where. The first repository is the main one: a stage writes its artifact file there, and the project's own repository fields follow it if it changes.

## What a sandbox contains

Git, the seven coding agent CLIs, and no language runtime. A repository's toolchain arrives through its own setup command rather than being baked into the image. See [pipeline.md](./pipeline.md#repository-commands).

Locally the sandbox is a Docker container the server creates through the host's daemon; hosted, it is a Fly.io Sprite that installs the agent CLIs on first use. Both sit behind one driver interface, along with a no-isolation local process driver used for development and CI.

## Spend

Agent spend is shown per card and per project where it is known, and never enforced. Bento prices nothing itself. It records the figure the tool reports, and only Claude Code and pi report one. A total therefore states how many runs it could not measure, rather than counting them as free.

## Tenancy

A local install has one user and no organizations, and every `organization_id` is null. A shared server puts every project inside an organization, and every member of that organization sees all of its projects. There is no per-project sharing.

Three layers keep a tenant's rows to itself, and each catches something the others do not:

- Route checks, which re-read membership on every request.
- Row-level security, which confines every query to the caller's organization.
- Insert triggers, which derive the tenant from the parent row.

The full table-by-table picture, with the delete rules: [diagrams/database_schema.md](./diagrams/database_schema.md).
