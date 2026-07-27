# Running the web console

The console is a React app in `apps/web`, served by Vite in development and by the API server itself in production. This is the long version; the README has the three commands.

## What runs, and where

| Process | Port | Started by |
|---|---|---|
| Postgres | 5439 | `docker compose up -d postgres` |
| API server (`apps/server`) | 4400 | `pnpm dev` |
| Vite dev server (`apps/web`) | 4401 | `pnpm dev` |
| TUI (`apps/tui`) | none | `pnpm dev` |

`pnpm dev` is `turbo run dev`, and every package with a `dev` script runs. That is all three at once, so there is no second command to start the console. Running `pnpm --filter @bento/web dev` afterwards starts a second Vite on a port already in use.

To run just the two you need:

```bash
pnpm --filter @bento/server --filter @bento/web dev
```

## Setup

Two ways in. Use the first to work on Bento and the second to run it.

### From source, with hot reload

```bash
docker compose up -d postgres    # Postgres on 5439
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Open http://localhost:4401.

`pnpm install` is needed once, and again whenever dependencies change. `pnpm db:migrate` is needed once, and again after a migration is added.

### Everything in containers

One command runs the whole stack, but agents need three values in `.env` first, and compose reads that file on its own:

```bash
cat >> .env <<'EOF'
BENTO_REPOS=/Users/you/code                # where your checkouts live
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...     # from: claude setup-token   (or set ANTHROPIC_API_KEY)
GIT_AUTHOR_NAME=Your Name                  # commit attribution; the container has no gitconfig
GIT_AUTHOR_EMAIL=you@example.com
EOF
docker compose up --build        # or: pnpm docker:up
```

Open http://localhost:4400. This builds two images — one holding the server and the built console, one for the sandboxes agents run in — then brings up Postgres, runs migrations, and starts the server, in that order. No Node and no pnpm on the host; the three `.env` values exist because the server now lives in a container, which can see neither your checkouts, nor your keychain, nor your gitconfig unless told where they are.

The ordering is enforced rather than hoped for. `migrate` and `sandbox-image` are one-shot services and `server` waits on `service_completed_successfully` for both, so it never starts against a schema that is behind or without the image its first card will need. Re-running is free: migrations take an advisory lock and apply only what is missing.

```bash
pnpm docker:logs                 # follow the server
pnpm docker:down                 # stop, keeping the database volume
docker compose down -v           # stop and delete the database
```

There is no hot reload here, so a code change needs `--build` again. That is why the first option stays the one for development.

Run one setup at a time. Both want port 4400, so a compose server that is still up will stop `pnpm dev` from binding, and the console on 4401 dies with it. `docker compose stop server` before switching to dev mode; `lsof -ti:4400 | xargs kill` before switching back.

## Why the console runs on its own port in development

Vite serves the console on 4401 and proxies `/api` to the server on 4400 (`apps/web/vite.config.ts`). That keeps hot module replacement while leaving every request same origin from the browser's point of view, which is what makes the session cookie, the OAuth callbacks, and the `/device` and `/accept-invitation` pages work without any CORS or cross-site cookie configuration.

Production has no second process: the server serves the built console itself when `BENTO_WEB_DIR` points at `apps/web/dist`, from the same origin as the API, for the same reason. That is why the deployed app needs no proxy config.

To exercise the production path locally:

```bash
pnpm build
BENTO_WEB_DIR="$PWD/apps/web/dist" pnpm --filter @bento/server dev
```

The console is then on http://localhost:4400 with no Vite involved.

## Local mode and multi mode

`BENTO_MODE` in `.env` decides how much of the console exists.

**`local`** is the default. One trusted user, no sign in, no organizations. The Team panel is hidden because there is no tenant boundary to manage, and secrets belong to no organization.

**`multi`** turns on the full auth surface: email and password, social login, the device flow the terminal and Mac app use, organizations, invitations, and per-organization agent credentials. It needs more configuration:

```bash
BENTO_MODE=multi
BENTO_SECRET_KEY=...        # openssl rand -hex 32, encrypts stored credentials
BETTER_AUTH_SECRET=...      # signs sessions
BETTER_AUTH_URL=http://localhost:4400
```

The server refuses to start in multi mode without `BENTO_SECRET_KEY`, because agent credentials are stored encrypted and there is nothing to encrypt them with.

## Agents need a sandbox

The console will happily show a board with no Docker running, but starting an agent will not work. `BENTO_SANDBOX_DRIVER` picks where runs execute:

- `docker` (default) needs the sandbox image built once:
  `docker compose build sandbox-image`
- `local-process` runs agents directly on your machine with no isolation. Fine for development and CI, not for anything else: an agent can reach whatever your user can.
- `sprite` is for hosted deployments.


## Using a subscription instead of an API key

Agents can reuse the Claude, Codex, Cursor, opencode, or pi login already on your machine, so a subscription you pay for drives the run and no API key is needed. You do not log in through Bento: you sign in with the tool itself (`claude auth login`), and Bento reuses that.

It is off by default, and there are three ways to turn it on:

- **The console**, under Agents. It is stored in the server's data directory and read per run, so it takes effect on the next run with no restart.
- **`bento setup`**, which also reports whether Claude Code is signed in and can run `claude auth login` for you.
- **`BENTO_SHARE_AGENT_AUTH=true`** in `.env`, or `bento --share-agent-auth`. An explicit environment variable wins over the stored setting, so a launch flag stays an override and CI stays predictable. The console shows the control as disabled when the environment has pinned it.

You do not sign in through the console: `claude auth login` opens a browser, so it has to run in a terminal on that machine.

What gets shared is each tool's own config directory, mounted read only into the sandbox: `~/.claude` and `~/.claude.json` for Claude Code, `~/.codex` for Codex, `~/.config/opencode` and `~/.local/share/opencode` for opencode. A directory you do not have is skipped, and the agent falls back to an API key from the environment. Your git identity is forwarded too, so agent commits are attributed to you rather than a placeholder.

Two things to be clear about:

**This is ignored in multi mode**, whatever the setting says. An operator's personal logins must never reach a tenant's sandbox.

**Read only is not a confidentiality boundary.** These are long lived credentials for a paid account, and an agent can read anything its sandbox can, so a prompt injection in a repository would be enough to take them. Use it on repositories you trust.

One consequence worth knowing: with `BENTO_SANDBOX_DRIVER=local-process` there is no container, so the agent inherits your environment including `HOME` and finds those logins whether or not the setting is on. That is not the setting working, it is there being no sandbox.

Sharing also assumes the server runs where the logins are. A server inside a container has no keychain and no `~/.claude` of yours to share, so for the container stack use `claude setup-token` and put the result in `.env` as `CLAUDE_CODE_OAUTH_TOKEN` instead.

## What the containers can and cannot do

The stack runs the server; agents are a separate question, because they run in sandboxes of their own.

The server creates those as **sibling containers** through the host's Docker daemon, which `docker-compose.yml` reaches by mounting `/var/run/docker.sock`. The daemon is the host's, so every path the server asks it to mount has to mean the same thing on the host as it does inside the server container. Two directories are therefore mounted at their own path rather than remapped:

| Variable | Default | What it is |
|---|---|---|
| `BENTO_STATE_DIR` | `/var/tmp/bento` | Worktrees and server state |
| `BENTO_REPOS` | the repository you ran compose from | The checkouts agents work in |

A project whose path falls outside `BENTO_REPOS` will have a worktree the sandbox cannot see, and the agent will find no code. Point it at whatever holds your checkouts:

```bash
BENTO_REPOS=$HOME/code docker compose up --build
```

This is verified rather than assumed: a card run from the container stack creates a real sibling container, and that container reads the checkout's files through the worktree. Two things had to be true for it, and both are now:

- **The server image carries git.** The server builds the worktrees itself, before any sandbox starts, so a server without git fails with a bare `spawn git ENOENT` and never reaches Docker at all.
- **Both mounts resolve to the same place.** They do so for different reasons, which is worth knowing on a mac: `BENTO_REPOS` is a real path on your machine, shared in through Docker's file sharing, while `BENTO_STATE_DIR` defaults to `/var/tmp/bento`, which lives inside Docker's Linux VM. Both containers agree on it, which is all the sandbox needs, but you will not find those worktrees in Finder. Set `BENTO_STATE_DIR` to a path under your home if you want to read them:

```bash
BENTO_STATE_DIR=$HOME/.bento-docker BENTO_REPOS=$HOME/code docker compose up --build
```

Agents also need the sandbox image. Compose builds it as part of `up --build`, as a service that produces the image and exits; to rebuild only that one, `docker compose build sandbox-image`. Without it, the board works, but an agent cannot start. `BENTO_SANDBOX_DRIVER=local-process` is not a way around this here: it would run agents inside the server container, which has no agent CLIs installed.

Credentials are the other half. The containerized server cannot reach this machine's keychain, so login sharing does nothing there; agents need either an API key or a subscription token in `.env`, which compose passes through:

```bash
ANTHROPIC_API_KEY=sk-ant-...              # an API key
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...    # or your subscription: claude setup-token
GIT_AUTHOR_NAME=Your Name                 # and commit attribution, since the
GIT_AUTHOR_EMAIL=you@example.com          # container has no global gitconfig
```

The token counts as a credential exactly like a key does, and a run started without either fails immediately with a message saying which is missing.

## Running the containers in multi mode

```bash
BENTO_MODE=multi \
BENTO_SECRET_KEY=$(openssl rand -hex 32) \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
docker compose up --build
```

Those three are passed through only when set, so local mode is never handed an empty key.

## Troubleshooting

**`404 /api/auth/get-session` in the browser console.** Expected in local mode. The console asks for a session before it knows which mode the server is in, and local mode mounts no auth routes. Harmless.

**The board is empty and `New project` does nothing.** The console talks to the API through Vite's proxy, so the server has to be up first. Check `curl localhost:4401/api/health`; it should report the mode and the sandbox driver.

**`EADDRINUSE` on 4400 or 4401.** Something is already listening, often a previous `pnpm dev` or a `bento serve`. `lsof -ti:4400 | xargs kill` clears it.

**Postgres connection refused.** `docker compose ps` should show `bento-postgres-1` healthy on 5439. The port is deliberately not 5432, so it does not collide with a Postgres you already run.

**Migrations out of date.** Symptoms are relation-does-not-exist errors from the API. `pnpm db:migrate` applies what is missing; the container stack does it on every `up`.

**The containerised server starts but nothing answers on 4400.** It binds `BENTO_HOST`, which compose sets to `0.0.0.0` because loopback inside a container is not reachable from outside it. The published port is `127.0.0.1:4400:4400`, so it stays reachable from that machine only.

## Where things are

| Path | What |
|---|---|
| `apps/web/src/App.tsx` | Screen routing, board state, the SSE subscription |
| `apps/web/src/components/Board.tsx` | Stage lanes and cards |
| `apps/web/src/components/FeatureDrawer.tsx` | One card: actions, transcript, gate |
| `apps/web/src/components/AgentsPanel.tsx` | Pairing a tool with a model |
| `apps/web/src/components/StageConfig.tsx` | Per stage agent and gate criteria |
| `apps/web/src/components/TeamPanel.tsx` | Organizations, members, credentials |
| `apps/web/src/styles.css` | All of the styling, no framework |

The console updates itself: it subscribes to `/api/board/:id/events`, a server-sent event stream, and refetches when the board changes. There is no refresh button because there is nothing to refresh.

## Working on Bento

Contributing needs the toolchain rather than the container stack, since the point is hot reload. Node 22 and pnpm, then Postgres and the sandbox image from compose:

```bash
docker compose up -d postgres --build sandbox-image
cp .env.example .env
pnpm install && pnpm dev
```

`pnpm dev` runs the API on :4400 and the console on :4401 with hot reload; Vite proxies `/api` so every request stays same origin. Open http://localhost:4401.

The `bento` CLI is its own workflow. `pnpm -C apps/tui link --global` puts it on your PATH as a symlink to the compiled `apps/tui/dist/cli.js`, so it shows your last build; while working on the CLI use `pnpm dev:cli` instead, which rebuilds what changed and runs from source. `pnpm watch` keeps `dist` fresh for a globally linked `bento` or a running server.
