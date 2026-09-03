# Bento Mac app

Native macOS command centre built with the Native SDK (vercel-labs/native). The view is `src/app.native` markup; the logic is `src/core.ts` in the app-core TypeScript subset (compiled to native code, no JS runtime in the binary).

## Three ways to run it

The same choices the `bento` command offers, picked on first launch:

- **Everything on this machine.** Spawns `bento serve` and polls the address it reports.
- **Use a server, agents on the server.** A thin client: no helper process.
- **Use a server, agents on this machine.** Spawns `bento runner --server <url>`, so the
  board is shared while agents run in local containers against local checkouts.

Signing in to a hosted server uses the same device flow the terminal does: the
app shows a code, you approve it in a browser, and every request then carries a
bearer token. Local mode needs no sign in.

The app has no JavaScript runtime, so it cannot host the server or run the
device flow itself. It spawns the `bento` CLI as a helper and reads its stdout,
which emits one `bento:<event> <value>` line per event, so there is one
implementation of the polling contract and no JSON parser in the app core.
`bento` must be on your PATH.

## What it does

The same surface as the web console and the terminal:

- **Board.** The backlog, the stage columns, and a Completed lane for finished
  work, plus a card detail pane with the live transcript, the card's history,
  and what its gate is still waiting on.
- **Card actions.** Start the pipeline, approve or reject, re-check the gate,
  start the stage's agent, stop it, continue in your own words (the agent keeps
  its session), send a card back a stage, mark it completed from anywhere, and
  delete it. Each card on the board also carries arrows that move it one stage
  either way without opening it.
- **Creation.** New project, new card.
- **Agents.** Pair a tool with a model, change an existing pairing, and delete one. Editing keeps the agent's id, so every stage assigned to it follows the change.
- **Pipeline.** Connect and remove repositories, add, remove and rename a stage,
  assign its agent, choose whether it waits for you or advances on its
  requirements, and turn its pull request on or off.
- **Team.** Switch and create organizations, invite members, change roles,
  remove members, and store the organization's agent credentials. Multi mode
  only; local mode has one trusted user and no organizations.

## How it talks to the server

Reads use line-based endpoints, one record per line with `|` between fields,
because there is no JSON parser in this binary:

- `GET /api/projects/plain` for the project list
- `GET /api/projects/:id/board/plain` every 3s for the board
- `GET /api/projects/:id/pipeline/plain` for stages, their agents, and their gates
- `GET /api/features/:id/gate/plain` and `/history/plain` for the detail pane
- `GET /api/features/:id/merge-status/plain` when a card is open, for the resolve-conflicts button
- `GET /api/runs/:id/transcript?since=<cursor>` every 1.5s for the live transcript
- `GET /api/profiles/plain`, `/api/secrets/plain`, `/api/team/plain`
- `GET /api/catalog/{models,tools,credentials}/plain` for the choices a form offers

Writes are ordinary JSON, built in `src/wire.ts`. Building a small object is far
cheaper than parsing an arbitrary one, so the app writes JSON and never reads it:
every write is followed by a refetch of the list it changed.

Buffered fetch is the only network primitive in Native SDK v1 (no SSE from
TypeScript cores), which is why the reads are polled and speak plain lines.

The catalogs are served rather than bundled because this app never reads
`node_modules` and so cannot import them from `@bento/core`. The server also
resolves each model's profile string, which differs per tool, so the app does
not have to know that rule.

## Provider logos

Agents carry the mark of the provider they bill, in the agents panel and
beside each stage's assigned agent.

The catalog ships each logo as an SVG data URI, which the web console
renders directly. This app cannot: the SDK bundles no image codecs and
decodes through CGImageSource, which does not read SVG. So the marks are
rasterised to PNG by `scripts/render-provider-logos.mjs`, checked in
under `assets/providers/`, and registered in `app.zon` under the ids
`logoIdFor()` in `src/wire.ts` maps to. Re-run that script after
`pnpm models:update`, and add any new provider to both places.

There are two renditions per provider because the marks are monochrome
and the app follows the system appearance; the core hears about that on
the `appearanceMsg` channel and the view picks the legible one.

An agent whose provider cannot be identified shows no mark rather than a
guess. `providerForProfile` in `@bento/core` only answers when the model
string names its provider, matches the catalog, or is the tool's own
default: every tool here can reach several providers, so guessing would
put one company's logo on another company's model.

## Three things to know before editing

**A POST with no body kills the app.** The SDK's HTTP client asserts that a
POST, PUT or PATCH carries one, and aborts the process when it does not. So
approve, reject, recheck, cancel and sign out all send `{}` even though the
server reads nothing. Neither `native check` nor `native test` sees this (the
spec is well typed either way), so `tests/fetch-contract.test.mjs` checks it
instead.

**A `Cmd.fetch` result is `ok` for any HTTP status**, a 4xx included. Every
write result checks `status` before treating the change as applied, or the
optimistic notice would stand while nothing had been saved.

**Keys are scoped to siblings; `global-key` is not.** Two lists in one container
whose rows both key on their index give two rows the same id, and the whole view
build fails with `DuplicateWidgetId`. Each list gets its own container. Only the
board cards use `global-key`, because they genuinely move between columns.

## Develop

Requires Node 22.15+ on PATH for the `native` CLI (pinned as a dev dependency at the repo root).

```bash
# from apps/mac, with the Bento server running (pnpm dev at the repo root)
../../node_modules/.bin/native check        # validate markup + core
../../node_modules/.bin/native test         # typed model contract checks
../../node_modules/.bin/native dev          # run the app, markup hot reloads
../../node_modules/.bin/native build        # ReleaseFast binary in zig-out/bin/
../../node_modules/.bin/native package --target macos   # .app bundle
```

Headless logic loop (no window). Dispatch Msgs as JSON lines and read the model
and effect transcript back, which is the cheapest way to check what a form
actually sends:

```bash
printf '%s\n' '{"kind":"projects_ok","status":200,"body":{"$bytes":"project|p1|Demo"}}' \
  | ../../node_modules/.bin/native dev --core
```

Driving the real window, which is the only way to catch a view that fails to
build:

```bash
../../node_modules/.bin/native dev --yes -Dautomation=true    # in one shell
../../node_modules/.bin/native automate snapshot              # widgets, ids, state
../../node_modules/.bin/native automate widget-click main-canvas <id>
```

The snapshot's `dispatch_errors=` counter and its `error event=` lines are worth
reading: a failed view build degrades to the previous frame rather than
crashing, so a panel that silently will not open shows up only there.
