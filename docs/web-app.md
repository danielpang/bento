# Running the web console

Console source: `apps/web`. Development: Vite on port 4401. Production: built assets served by the API server. See README for the minimal setup.

## Processes


| Process        | Port | Start command                   |
| -------------- | ---- | ------------------------------- |
| Postgres       | 5439 | `docker compose up -d postgres` |
| API server     | 4400 | `pnpm dev`                      |
| Vite (console) | 4401 | `pnpm dev`                      |
| TUI            | none | `pnpm dev`                      |


`pnpm dev` starts all packages with a `dev` script via turbo. Do not start `@bento/web` separately.

Server and console only:

```bash
pnpm --filter @bento/server --filter @bento/web dev
```

## Setup



### Source (hot reload)

```bash
docker compose up -d postgres
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Open [http://localhost:4401](http://localhost:4401).

Re-run `pnpm install` when dependencies change. Re-run `pnpm db:migrate` after new migrations.

### Docker (full stack)

```bash
cat >> .env <<'EOF'
BENTO_REPOS=/Users/you/code
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...
EOF
docker compose up --build
```

Open [http://localhost:4400](http://localhost:4400). No Node or pnpm required on the host.

`BENTO_REPOS`: required when checkouts are outside the compose working directory. Claude token may be set in **Agents** instead. Commit author: **Settings, GitHub**.

Migrations and sandbox image build complete before the server starts. Migrations are idempotent (advisory lock).

```bash
pnpm docker:logs
pnpm docker:down              # retain database volume
docker compose down -v        # delete database volume
```

Code changes require `docker compose up --build`. No hot reload.

Do not run both setups concurrently (port 4400 conflict):

```bash
docker compose stop server    # before switching to pnpm dev
lsof -ti:4400 | xargs kill    # before switching back to compose
```



## Development port layout

Vite (4401) proxies `/api` to the API server (4400) for same-origin cookies and OAuth.

Production serves `apps/web/dist` from the API server when `BENTO_WEB_DIR` is set.

Local production test:

```bash
pnpm build
BENTO_WEB_DIR="$PWD/apps/web/dist" pnpm --filter @bento/server dev
```

Console: [http://localhost:4400](http://localhost:4400).

## Modes

`BENTO_MODE` in `.env`:


| Mode              | Behavior                                           |
| ----------------- | -------------------------------------------------- |
| `local` (default) | Single user, no auth, no organizations             |
| `multi`           | Auth, organizations, encrypted per-org credentials |


Multi mode requires:

```bash
BENTO_MODE=multi
BENTO_SECRET_KEY=...      # openssl rand -hex 32
BETTER_AUTH_SECRET=...    # openssl rand -hex 32
BETTER_AUTH_URL=http://your-bento-url..
SPRITES_TOKEN="<fly sprites token>"
```

Server startup fails in multi mode without `BENTO_SECRET_KEY`.

## Sandbox driver

The board loads without a sandbox. Agent runs require one.


| Driver             | Use                                                              |
| ------------------ | ---------------------------------------------------------------- |
| `docker` (default) | Isolated containers. Build: `docker compose build sandbox-image` |
| `local-process`    | No isolation. Development and CI only                            |
| `sprite`           | Hosted (Fly) deployments                                         |




## Subscription credential sharing

Local mode only. Ignored in multi mode.

When enabled, Bento mounts local tool config directories read-only into the sandbox (`BENTO_SHARE_AGENT_AUTH`, console **Agents**, or `bento setup`). Credentials remain readable by the agent process; not a confidentiality boundary.

`local-process` inherits the host environment regardless of this setting.

Docker-hosted servers cannot access host Keychain or `~/.claude`. Use `claude setup-token` → **Agents** or `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

## Docker compose constraints

Agents run in sibling containers via the host Docker socket. Mounted paths must resolve identically on host and server container.


| Variable          | Default                   | Purpose                 |
| ----------------- | ------------------------- | ----------------------- |
| `BENTO_STATE_DIR` | `/var/tmp/bento`          | Worktrees, server state |
| `BENTO_REPOS`     | compose working directory | Repository checkouts    |


Example:

```bash
BENTO_REPOS=$HOME/code docker compose up --build
BENTO_STATE_DIR=$HOME/.bento-docker BENTO_REPOS=$HOME/code docker compose up --build
```

On macOS, default `BENTO_STATE_DIR` is inside Docker's VM and not visible in Finder.

Server image includes git. Sandbox image is built on `up --build`. Without it, the board loads but runs fail.

Pass agent credentials via `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...
```

Runs fail at start if no credential is configured.

## Multi mode in Docker

```bash
BENTO_MODE=multi \
BENTO_SECRET_KEY=$(openssl rand -hex 32) \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
docker compose up --build
```



## Troubleshooting


| Symptom                                   | Cause / fix                                              |
| ----------------------------------------- | -------------------------------------------------------- |
| `404 /api/auth/get-session` in local mode | Expected. Console probes session before mode detection   |
| Empty board, `New project` inactive       | API unavailable. Check `curl localhost:4401/api/health`  |
| `EADDRINUSE` on 4400/4401                 | Stale process. `lsof -ti:4400 | xargs kill`              |
| Postgres connection refused               | Start postgres: `docker compose ps` (port 5439)          |
| Relation does not exist                   | Run `pnpm db:migrate`                                    |
| Container server not reachable on 4400    | `BENTO_HOST=0.0.0.0`; published as `127.0.0.1:4400:4400` |




## Source layout


| Path                                        | Responsibility                  |
| ------------------------------------------- | ------------------------------- |
| `apps/web/src/App.tsx`                      | Routing, board state, SSE       |
| `apps/web/src/components/Board.tsx`         | Lanes, Done, search             |
| `apps/web/src/components/FeatureDrawer.tsx` | Card actions, transcript, gates |
| `apps/web/src/components/AgentsPanel.tsx`   | Agent CRUD, YAML                |
| `apps/web/src/components/StageConfig.tsx`   | Stage config, pipeline YAML     |
| `apps/web/src/components/TeamSettings.tsx`  | Organizations, credentials      |


Updates via SSE: `/api/board/:id/events`.

## Implementation notes

**Done lane:** status-driven, not a stored stage. **Mark done** and drag-to-Done skip remaining stages. **Reopen** restores prior stage.

**Search:** filtered in `Board.tsx` via `matchesQuery` (`apps/web/src/search.test.ts`). Punctuation-normalized matching.

**Icons:** hashed URLs in `index.html` and `site.webmanifest` (Vite plugin) to invalidate browser favicon cache.

**Changelog:** `apps/web/src/changelog.ts`. Entry `id` values are stable anchors; do not rename published ids.

## Development workflow

```bash
docker compose up -d postgres --build sandbox-image
cp .env.example .env
pnpm install && pnpm dev
```

CLI: `pnpm -C apps/tui link --global` (symlink to `dist/cli.js`). TUI development: `pnpm dev:cli`. Watch build: `pnpm watch`.