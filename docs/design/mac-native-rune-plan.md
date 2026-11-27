# Bento for Mac, native in Rune: implementation plan

Status: proposal, 2026-11-27. Design canvas: https://claude.ai/artifact/1JWEZZq1MMcpngRJmDYksg

## What this replaces

The Mac app today is `apps/desktop`: Electron 44, about 1,850 lines of runtime code, wrapping the web console (`apps/web`, about 53,000 lines) and running `@bento/server` in a utility process. Everything a person sees is the web console.

The goal is a native app in Rust on Rune (github.com/anomalyco/rune, pin `7a7ed14e93` of `dev`, 2026-11-26), GPU rendered, with a native layout (sidebar, main pane, inspector) and liquid metal from `rune-fx` as the signature material.

An earlier native attempt (Vercel Native SDK, Zig) was removed in #284. Its build leftovers are still in `apps/mac` (untracked: `zig-out`, `.native`, `.zig-cache`). They should be deleted before the new crate goes there, with your say so.

## What Rune gives us, and what it does not

| Need | Rune | Notes |
|---|---|---|
| Window frame | `rune_kit::shell::SplitView`, `Sidebar`, `Toolbar`, inspector pane | Resizable, collapsible, traffic light clearance built in |
| Transcript | `rune_kit::Markdown` | Built for streaming, syntax colour, native Mermaid, selectable |
| Changes | `rune_kit::diff::DiffView`, `Tree`, `FileTree` | Unified and split, line comments, 50,000 line diffs |
| Composer | `TextArea::plain`, `PopupList`, mention pills | |
| Controls | Button, Select, Menu, Dialog, Popover, Toast, SegmentedControl, Table, Combobox | |
| Theme | `Kit::from_palette` plus overrides | Bento tokens map directly |
| Liquid metal | `rune_fx::Fx::fill(LiquidMetalParams)` | Not a component. Drawn by a `Compositor` at `El::effect` slots |
| Mac integration | `Tray`, `App::on_open_url`, `rune::credentials` (Keychain), `rune-notify`, multi window, native menus, file dialogs | |
| Headless checks | `--snap`, `--tree`, `--script` | Every screen can be rendered to PNG and driven in CI |
| Webview | None | The one real gap. See "HTML artifacts" |
| HTTP, SSE | None | We bring `reqwest` and write the stream reader |
| Release packaging | `scripts/mac-app` makes development bundles only | Signing, notarizing, and updates are ours |
| Stability | Pre-release, no pull requests accepted | Pin a rev, file issues, keep a fork as the fallback |

## Architecture

```
apps/mac/                      Cargo workspace (Rust 1.99.1, as Rune pins)
  crates/bento-client/         REST + SSE + device flow. No UI. Tested against a real server
  crates/bento-app/            The Rune app
    src/main.rs                AppSpec, windows, menus, tray, deep links
    src/state.rs               One State per window: connection, project, selection, caches
    src/theme.rs               Bento tokens -> Kit (dark, light, dark blue; three accents)
    src/metal.rs               The Compositor: effect slots -> liquid metal layers
    src/sidecar.rs             Supervises the local server process
    src/screens/               launcher, board, inspector, sessions, artifacts, swarm, analytics, settings
    src/parts/                 card, lane, orb, key (metal button), transcript, composer, question
  sidecar/                     Node entry that boots @bento/server (today's runtime.ts, moved)
  scripts/                     bundle, sign, notarize, dmg, appcast
```

**The server stays TypeScript.** The app bundles a Node binary and an esbuild bundle of `@bento/server`, and `sidecar.rs` starts it as a child process, as Electron's utility process does now. `runtime.ts`, `docker-start.ts`, and `sandbox-progress.ts` move into `sidecar/` nearly unchanged. Progress ("Installing the agent tools, step 2 of 6") comes back as JSON lines on stdout. Stop is graceful with the same 12 second limit. Rewriting the server in Rust is out of scope.

**The client is a Rust crate.** `bento-client` speaks the same API the console does: bearer token from the device flow (`clientId: "bento-desktop"`), token in the Keychain, SSE readers for `/api/runs/:id/events`, `/api/board/:projectId/events`, and `/api/swarms/:id/events` that resume by sequence number. Types are hand written with serde for the endpoints the app uses. Its tests run against a real local server, never a stub, per the "verify against something real" rule in CLAUDE.md.

**State and threads.** Rune runs views on the main thread. Requests run on `rune::task::spawn` and deliver through `AppHandle::update_if`. Search uses `rune::Latest`. Streams append to the transcript model and never rebuild the whole view: `Markdown` keeps earlier blocks mounted.

**Liquid metal.** `metal.rs` follows `examples/showreel/src/gfx.rs` (about 200 lines). Each metal element is an `El::effect(mark)` slot under its content, with `effect_data` carrying the preset, border width, and flow. Flow is fed by run activity, so a ring moves only while events arrive. `Compositor::animating` returns true only while a flowing slot is on screen, so an idle window draws nothing. `FxRenderer::supported` is checked at start, and an unsupported GPU gets flat fills. Reduce Motion settles every fill.

**HTML artifacts.** CLAUDE.md requires agent HTML to run only in a sandbox with no same origin access. Rune cannot host a webview inside its element tree. Plan: markdown, images, and diagrams render natively in the Artifacts pane; an HTML preview opens in a separate small AppKit window holding a `WKWebView` (through `objc2`), with a non-persistent data store, no cookies, navigation blocked, and the content loaded as `srcdoc` inside `<iframe sandbox="allow-scripts">`, exactly the rule the console follows. If an in-pane preview is wanted later, the same view can be positioned over a Rune element's rect.

**Settings.** Appearance, Projects, Providers, Config, and Account are native. GitHub, Linear, Slack, MCP, Team, and Billing open the console's Settings page in the browser at first. OAuth already has to happen there (`DesktopIntegrationNote`), so this is the current behaviour for those tabs.

## Design summary

The canvas has six artboards: Board, Sessions, Swarm, Liquid metal system, Launcher, Menu bar and notification.

- **Layout.** The web top bar becomes a sidebar: project, Board, Sessions, Artifacts, Swarms, Analytics, then two live lists, "Running now" and "Needs you". The card drawer becomes the inspector pane.
- **Metal means alive or decisive.** Chrome ring: an agent is working. Bento copper: the one primary action in a view. Gold, still: waiting on a person (gate, question, approve). Gunmetal: at rest. Status dots keep their meaning (blue running, green succeeded, coral failed, gold gated).
- **New for the Mac.** A menu bar panel with what needs you and what is running, a notification when an agent asks a question or a card reaches a gate, `bento://` links, and a quick "New card" field.
- **Copy.** The canvas introduces strings that are not in the console today ("Running now", "Needs you", "The agent is waiting on you", "Create pull request" on the swarm header, "Approve and advance"). They are proposals and need your approval before any ships. The Bento mark on the launcher is a placeholder shape.

## Phases

Each phase ends with something run for real: the app driven on a Mac against a live local server, plus headless snapshots in CI.

**0. Spikes (about a week).** Four throwaway proofs, because each can change the plan:
1. Rune window with the Bento theme, Geist fonts, and a chrome ring and copper key drawn by a compositor. Measure idle and flowing GPU cost.
2. Node sidecar: boot the bundled server from a Rust parent inside a signed, hardened bundle (needs the JIT entitlement), reach `/api/health`.
3. `WKWebView` window beside a Rune window, sandbox rules verified with a hostile test page.
4. SSE reader against a real run, including resume after a dropped connection.

**1. Foundation.** Workspace, `bento-client` (health, device flow, projects, features, runs, streams), Keychain storage, `sidecar.rs`, launcher screen with the same options as today (sandbox type, model proxy, beta features, data folder, PostgreSQL URL, sandbox image, restart to apply), shell with sidebar and empty panes, themes.

**2. Board and inspector.** Lanes and cards from `/api/features` with the board stream, drag between stages, new card composer, inspector with Overview and Chat: streaming transcript, tool groups, question cards with answers, composer with model picker, Stop (interrupt or rest, per `stop-action.ts`), approve, reject, advance, back.

**3. Sessions, changes, artifacts.** Sessions list and full conversation view, Changes tab with `DiffView` and file tree, History, older events paging (`/events/before`), Artifacts grid and reader, HTML preview window.

**4. Swarms and the rest.** Swarm tree, node inspector, merge queue, publish, budget, the plan and waitlist gates (`PLAN_LIMIT`, `SWARM_WAITLIST`, `SWARM_ACCESS_UNAVAILABLE`). Analytics. Native settings tabs. Agents, Pipeline, and Repositories panels. Command menu.

**5. Mac integration.** Menus matching today's (Connection Settings, New Window, Switch Connection, Board, Sessions, Artifacts), several windows and connections side by side, tray panel, notifications, `bento://` links, window frame memory.

**6. Ship.** Universal binary, bundle, Developer ID signing with hardened runtime, notarization, DMG and zip, CI on `macos-15` reusing the `DESKTOP_*` and `APPLE_*` secrets. Updates through Sparkle 2. Keep the bundle id `ai.usebento.desktop` so the last Electron release can update straight into the Rune build; that path gets its own test before any release. Then retire `apps/desktop`.

Phases 2 to 4 are most of the work: they re-implement in Rust what `apps/web` does in about 53,000 lines. Phase 2 is a usable app for local single project work, and the Electron app keeps shipping until phase 6.

## Risks

- **Two consoles to maintain.** Every console feature now needs a Rust twin. Mitigation: the browser fallback for long tail settings, and a parity checklist per release. This is the largest ongoing cost of the project.
- **Rune is pre-release.** APIs move and upstream takes issues, not pull requests. Pin the rev, bump on purpose, keep a fork ready.
- **API drift.** Hand written Rust types can fall behind the server. Mitigation: the client's contract tests run in the main CI against the real server, so a changed route fails there.
- **GPU effects on battery.** Flow only while runs are active and visible, and measure in spike 1.
- **Update migration.** Electron's updater installing a non Electron bundle is plausible and unproven. Test early; the fallback is a one time manual download.
- **Tenant rules still apply.** The app is a bearer client like the TUI and adds no routes. If a native feature needs a new endpoint, it follows the route check and matrix test rules.

## Decisions (2026-11-27)

1. The old Zig leftovers in `apps/mac` are deleted and the Rust workspace lives there.
2. HTML artifact previews live in the pane, not a separate window. The `WKWebView` is a child view of the window, positioned over the Artifacts pane's rect each frame, with the same sandbox rules. Spike 3 changes to prove this: the view has to track the pane through resize, sidebar motion, and scroll, and hide whenever a Rune overlay (menu, dialog) would sit over it, because a native view always draws above Rune's surface.
3. Long tail settings open in the browser for the first release.
4. The first release is local mode only. Sign in, team switching, billing gates, and beta rules are out of phases 2 to 4.

## Local mode without Docker or Postgres installed

Today local mode needs Docker twice: `ensureLocalPostgres` runs Postgres in a container, and the default sandbox driver is Docker. Both can go.

**Postgres stays, Docker does not have to run it.** The server depends on real Postgres features throughout (pg-boss queues, LISTEN and NOTIFY for the event bus, roles and row level security, triggers, advisory locks, 79 migrations), so moving to SQLite would be a rewrite of the server. Instead the app ships Postgres itself: the bundle carries the Postgres binaries, the sidecar runs `initdb` into the data folder on first launch, starts `postgres` on a loopback port, and stops it on quit. The person installs nothing. This belongs in `@bento/server` as a second path beside the Docker one, so the CLI and TUI get it too. It adds roughly 40 to 60 MB to the download. PGlite (Postgres compiled to WebAssembly, in process) would be smaller, but it serves one connection at a time and the server uses several pools plus a dedicated LISTEN connection, so it is the riskier choice.

**The sandbox already has a Docker free driver.** "Local process" (`packages/sandbox/src/local-process.ts`) runs the agent directly on the Mac in a git worktree. It has no isolation: the agent has the person's permissions, and the model proxy does not apply to it. So the choice becomes: use Docker when it is installed and running (isolated, the default), otherwise offer Local process with its existing warning. A later step can confine the local process with a macOS sandbox profile that limits writes to its worktree.

With both, a fresh Mac runs local Bento with only the app and an agent CLI installed. This becomes spike 5 (embedded Postgres boots, all migrations apply, a run completes on the local process driver) and part of phase 1.

## Progress

- 2026-11-27: workspace created in `apps/mac`, pinned to Rune `7a7ed14e93`. First slice builds and renders headless: window frame with sidebar and inspector, the board on fixture data, and the liquid metal compositor (flowing chrome ring on running cards, still gold ring and key on a gated card, copper key for the primary action). Run with `cargo run` in `apps/mac`, or `./target/debug/bento-mac --snap board.png --theme dark` for a still. Not yet done: any server connection, Geist fonts (the repo has woff2 only, Rune needs ttf or otf), the other four spikes.
- 2026-11-27: work package 3, real data in local mode. `cargo run` starts the sidecar (`src/sidecar.rs`), shows its progress on a boot screen, then the real board from the server: lanes from the pipeline, cards with status and metal from their newest run, the board stream refetching on every change, card actions, a New card dialog, and an inspector that streams the active run. Fixture scenes (`--scene board|no-inspector|gated|boot|boot-failed|empty|new-card`) still render with no server. `BENTO_SERVER_URL` attaches to a running server instead of starting one.
- 2026-11-27: the five other pages. Each lives in its own module under `crates/bento-app/src/pages/` with its client calls in `crates/bento-client/src/api/`, behind one seam (`pages/mod.rs`): Sessions (list, live transcript, composer, Stop, Changes, new session), Artifacts (list, search, native Markdown, text and image reader; HTML and SVG are never rendered, HTML opens in the browser console), Swarms (list, live task tree, merge queue, task drawer with worker logs, actions, new swarm; no Publish), Analytics (the console figures with native charts), and Settings (agents and provider keys, projects and stages, Local Bento options with restart, appearance; the rest opens in the browser). The card drawer is hidden until a card is selected.
