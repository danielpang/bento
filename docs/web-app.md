<h1 align="center">Running the web console</h1>

For the terminal client, see [Bento in the terminal](./tui.md).

Console source: `apps/web`. Development: Vite on port 4401. Production: built assets served by the API server. See README for the minimal setup.

## Processes


| Process        | Port | Start command                   |
| -------------- | ---- | ------------------------------- |
| Postgres       | 5439 | `docker compose up -d postgres` |
| API server     | 4400 | `pnpm dev`                      |
| Vite (console) | 4401 | `pnpm dev`                      |
| TUI            | none | `pnpm dev`                      |


`pnpm dev` starts all packages with a `dev` script via turbo. Do not also start a second copy of `@bento/web`.

Server and console only:

```bash
pnpm --filter @bento/server --filter @bento/web dev
```

For UI-only work with the Docker API already running, start only Vite:

```bash
pnpm --filter @bento/web dev --host 127.0.0.1 --strictPort
```

Open [http://localhost:4401](http://localhost:4401). UI edits reload automatically without rebuilding Docker. The API and database must still be running.

If OrbStack's published port 4400 is unavailable but its container hostname responds, use the direct API address:

```bash
BENTO_API_TARGET=http://server.bento.orb.local:4400 pnpm --filter @bento/web dev --host 127.0.0.1 --strictPort
```

`BENTO_API_TARGET` overrides Vite's development proxy only. It defaults to `http://127.0.0.1:4400` and is not included in browser code.

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



## Log export

The server logs through `console`, and every line is also shipped as an
OpenTelemetry log record over OTLP/HTTP. Local output never depends on
the export: the original console method runs first, and an unreachable
collector only costs the copy.

Where the records go is decided at boot, in this order:

1. `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, used as written.
2. `OTEL_EXPORTER_OTLP_ENDPOINT`, with `/v1/logs` appended.
3. PostHog, when `POSTHOG_API_KEY` is set in multi mode (the hosted
   default, needing nothing but the project token).
4. Nowhere.

The first two are the standard OpenTelemetry names, so a self-hosted
install points the export at its own collector, Grafana Loki, Datadog,
Honeycomb, or any other OTLP backend with no code change, and PostHog
keeps receiving events, errors, and flags if its key is also set.
Naming an endpoint works in local mode too; only the PostHog default is
suppressed there. Credentials go in `OTEL_EXPORTER_OTLP_HEADERS` (or
the `_LOGS_HEADERS` variant) as comma separated `key=value` pairs:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_HEADERS=x-api-key=abc123
```

The exporter also honours `OTEL_EXPORTER_OTLP_TIMEOUT`,
`OTEL_EXPORTER_OTLP_COMPRESSION`, and the `_CERTIFICATE`,
`_CLIENT_KEY`, and `_CLIENT_CERTIFICATE` variables from the process
environment. `OTEL_SERVICE_NAME` sets the `service.name` resource
attribute (default `bento-server`); every record also carries
`bento.mode` and `environment`, the latter from `BENTO_ENVIRONMENT`.
The boot summary prints the destination as `log export: ...`.

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

**Board and Sessions (beta):** Board shows the pipeline; Sessions is the grouped card list and conversation workspace. There is no separate Board/List toggle. Both share search and the remembered All cards, Needs you, and Running filters. Sessions retains the latest agent, run count, activity date, and reported cost, with recent conversations first within each group. Cards awaiting their first run appear under Up next. These controls use `beta-testers`, enabled in local mode.

**Board focus (beta):** Needs you includes held cards and failed or stopped runs, excluding completed cards and cards with an active agent.

**Focused review (beta):** Opening a card in Sessions, or from Board's Needs you or Running filters, shows the queue on the left, chat in the center, and the original-width detail drawer on the right. The drawer omits its Chat tab while the center conversation is visible. Below 1280px, chat returns to the drawer, and Sessions opens its Chat tab by default. The conversation and draft are preserved when resizing. Closing the card returns to the current route's board or list. A single board stream updates the list and open card.

**Keyboard (beta):** The web shortcuts follow the TUI: `n` opens a new card, `/` focuses board search, and `:`, `?`, or `Ctrl+P` finds cards and actions. `j` and `k` open the next or previous visible card. Typing in a field does not trigger these shortcuts. Configure groups the agent, pipeline, and repository panels. Card handoffs show recorded changes, automated requirement results, and output from the latest run in the current stage.

**Icons:** hashed URLs in `index.html` and `site.webmanifest` (Vite plugin) to invalidate browser favicon cache.

**Stale tabs:** the build stamps a build id into `index.html` (`<meta name="bento-build">`, from `SOURCE_COMMIT` or a hash of the emitted files; `apps/web/src/build-id.ts`, names in `@bento/core`). The server reads it from the shell it serves and sends it as `x-bento-build` on every API response and as `build` in `/api/health`. The console compares that with its own page (`apps/web/src/build-watch.ts`) and shows a reload toast, bottom left with the other toasts but with no lifetime, on the first mismatch, which after a deploy is the board refetch that follows the stream reconnect. The shell is served with `no-cache` (the build id is its ETag) and a missing file is a 404 rather than the shell, so a reload actually gets the new build. A lazy chunk that fails to load reloads the page once per build (`main.tsx`). The Vite dev server stamps nothing, so none of this runs locally.

**Changelog:** `apps/web/src/changelog.ts`. Entry `id` values are stable anchors; do not rename published ids.

## Development workflow

```bash
docker compose up -d postgres --build sandbox-image
cp .env.example .env
pnpm install && pnpm dev
```

CLI: `pnpm -C apps/tui link --global` (symlink to `dist/cli.js`). TUI development: `pnpm dev:cli`. Watch build: `pnpm watch`.
