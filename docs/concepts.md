# How it works

Each feature is a card that moves through your stages. When a card enters a stage, the agent assigned to that stage runs inside a sandbox containing git worktrees of your repositories. Stages hand context to each other through committed artifact files (`docs/bento/<stage>.md`), so a card designed by one agent can be implemented by a different one.

## Cards, sandboxes and worktrees

One card, one branch, one sandbox. The sandbox is created when the card's first agent runs and outlives that run, so the second stage starts warm: the dependencies its setup command installed are still there, and so are the caches the first agent built. On hosted sandboxes it outlives the server too: a deploy in the middle of a run does not end it, because the sandbox keeps the agent working through the disconnect and the restarted server reattaches to it.

A follow-up message on a card continues the same CLI session when the tool prints a session id (Claude Code, Codex, Cursor, opencode, pi). Tools that cannot resume, and sessions the sandbox no longer holds, start a fresh run with the stage prompt plus a compacted transcript of what was said. Live tools (pi, Claude Code) also keep the process open for a short idle window after a turn on a manual stage, so you can keep talking without starting a new run.

**A project can span several repositories.** Each gets its own worktree inside one feature workspace, so a change touching a frontend and a backend is a single card:

```
<data-dir>/worktrees/<featureId>/web
<data-dir>/worktrees/<featureId>/api
```

With one repository the agent starts inside it. With several it starts at the workspace root and the prompt lists what is checked out where. The first repository is the main one: a stage writes its artifact file there, and the project's own repository fields follow it if it changes.

## What a sandbox contains

Git, the five coding agent CLIs, and no language runtime. Which toolchain a repository needs is a fact about that repository, so it arrives through that repository's own setup command rather than being baked into an image that would have to guess. See [pipeline.md](./pipeline.md#repository-commands).

Locally the sandbox is a Docker container the server creates through the host's daemon; hosted, it is a Fly.io Sprite that installs the agent CLIs on first use. Both sit behind one driver interface, along with a no-isolation local process driver used for development and CI.

## Spend

Agent spend is shown where it is known, per card and per project, and never enforced. Bento prices nothing itself: it records the figure the tool prints, and only Claude Code and pi print one, so a total says how many runs it could not measure rather than quietly counting them as free.

## Tenancy

A local install has one user and no organizations, and every `organization_id` is null. A shared server puts every project inside an organization, and every member of that organization sees all of its projects; there is no per-project sharing. Three layers keep a tenant's rows to itself, and each catches something the others do not: route checks that re-read membership per request, row-level security that confines every query to the caller's organization, and insert triggers that derive the tenant from the parent row.

The full table-by-table picture, with the delete rules: [diagrams/database_schema.md](./diagrams/database_schema.md).
