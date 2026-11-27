# Bento Mac sidecar

The Node process the native Mac app starts to run local Bento. It boots Postgres from bundled binaries (no Docker, nothing installed), then `@bento/server` in local mode on a loopback port, and reports what it is doing as JSON lines on stdout.

## Run it

Dev, from source, without bundling. The workspace packages it imports are read from their built `dist`, so build them once first:

```sh
pnpm --filter "@bento/mac-sidecar^..." build
BENTO_DATA_DIR=/tmp/bento-dev pnpm --filter @bento/mac-sidecar exec tsx src/main.ts
```

`pnpm -s dev` in this folder does the same. Use `-s`: without it pnpm prints its own banner on stdout, which breaks the protocol.

Bundled, for the app:

```sh
pnpm --filter "@bento/mac-sidecar^..." build
pnpm --filter @bento/mac-sidecar bundle
BENTO_DATA_DIR=/tmp/bento-dev node apps/mac/sidecar/dist/bin/sidecar.mjs
```

`bundle` writes a self contained `dist/`. Ship the whole folder; the script reads the rest relative to itself:

| Path | What |
|---|---|
| `dist/bin/sidecar.mjs` | One ESM file with the server and every npm dependency. Runs with plain `node` 22 or later. |
| `dist/migrations/` | The database migrations. `@bento/db` resolves them as `<script dir>/../migrations`. |
| `dist/postgres/` | Postgres 17 (`bin`, `lib`, `share`) for the architecture it was built on, thinned to one architecture with duplicate libraries replaced by symlinks. Set `BENTO_SIDECAR_ARCH=x64` to bundle Intel instead. |
| `dist/sandbox/Dockerfile` | The agent sandbox image, built when the Docker driver finds none. |
| `dist/web/` | The web console, copied only when `apps/web/dist` exists. |

It is named `bundle` rather than `build` so the repository wide `turbo run build` does not copy 70 MB of binaries on every build.

## Configuration

Environment variables only. All are optional.

| Variable | Default | Meaning |
|---|---|---|
| `BENTO_DATA_DIR` | `~/.bento` | Everything local Bento keeps. Postgres lives in `<dir>/postgres`, its password in `<dir>/postgres-password`. |
| `BENTO_SANDBOX_DRIVER` | `local-process` | `local-process` (no isolation, agents run as you in a git worktree) or `docker`. |
| `BENTO_DATABASE_URL` | none | A PostgreSQL URL to use instead of starting the embedded database. |
| `BENTO_SIDECAR_PORT` | `0` | The HTTP port. `0` picks a free one; a taken port also falls back to a free one. The real port is in the `ready` line. |
| `BENTO_POSTGRES_DIR` | `dist/postgres` beside the bundle, else the `@embedded-postgres/<platform>-<arch>` npm package | A folder holding Postgres's `bin`, `lib` and `share`. |
| `BENTO_WEB_DIR` | `dist/web` beside the bundle, if present | The console build the server serves at `/`. |
| `BENTO_SANDBOX_IMAGE` | `bento-sandbox:dev` | Docker driver only. |
| `BENTO_SANDBOX_DOCKERFILE_DIR` | `dist/sandbox` beside the bundle | Docker driver only: where the Dockerfile for a missing image is. |
| `BENTO_BETA_FEATURES` | server default (off) | `true` or `false`. |
| `BENTO_MODEL_PROXY` | server default (on) | `true` or `false`. |

With the Docker driver the sidecar starts OrbStack or Docker Desktop if one is installed and not running, and builds the sandbox image when it is missing, reporting progress the way the Electron launcher does. With `local-process` it never talks to Docker.

## Protocol

stdout carries only JSON objects, one per line. Server logs, Postgres logs (prefixed `[postgres]`) and stack traces go to stderr.

```json
{"event":"progress","message":"Starting the local database."}
{"event":"progress","message":"Setting up the database and starting Bento."}
{"event":"ready","url":"http://127.0.0.1:64500","port":64500,"databasePort":64497,"sandbox":"local-process"}
{"event":"error","message":"BENTO_SANDBOX_DRIVER must be \"local-process\" or \"docker\", not \"sprite\"."}
{"event":"stopping","reason":"SIGTERM"}
{"event":"stopped","code":0}
```

`progress` can repeat (the sandbox image build sends one every five seconds). `ready` comes once. `error` is followed by `stopping` and `stopped` with code 1, and the process exits 1. `databasePort` is null when `BENTO_DATABASE_URL` was given. Ignore unknown events and fields.

## Stopping

Any of these stops it: SIGTERM, SIGINT, its stdin reaching end of file, or its parent process exiting. The order is the HTTP server (which lets go of its runs), then Postgres with a fast shutdown. After 12 seconds it kills Postgres and exits 1.

Give it stdin as a pipe and keep the write end open for as long as it should run (`Stdio::piped()` in Rust, and do not drop the handle). Closing it is a clean way to stop the sidecar, and it is what happens on its own when the parent crashes. Do not start it with stdin on `/dev/null`: that is end of file at once. A FIFO does not work either: macOS never reports its end, so only the parent exit check catches that case, within a second.

A Postgres left running by a sidecar that was killed outright (SIGKILL) is stopped by the next start on the same data folder before it starts its own, and a stale `postmaster.pid` is removed.

## Talking to the server

Local mode has one implicit user and no sign in: no token, cookie, CSRF token or Origin header is needed. Send JSON bodies with `content-type: application/json`, or the body is not read. For example:

```sh
curl -s http://127.0.0.1:PORT/api/health
curl -s -X POST http://127.0.0.1:PORT/api/projects -H 'content-type: application/json' -d '{"name":"Demo","localPath":"/path/to/a/git/checkout"}'
curl -s -X POST http://127.0.0.1:PORT/api/features -H 'content-type: application/json' -d '{"projectId":"<id>","title":"First card"}'
curl -s "http://127.0.0.1:PORT/api/features?projectId=<id>"
```
