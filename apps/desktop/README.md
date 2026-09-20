# Bento for macOS

The Electron application includes the complete shared web console and the Bento
server. It is independent of the older Native SDK app in `apps/mac`.

## Run from source

Use Node 22.19 or newer and pnpm 9.15.4:

```sh
pnpm install
pnpm dev:desktop
```

Choose **On this Mac** or **Connect to a server**. Bento remembers the connection
and reconnects on the next launch. Open **Bento > Connection Settings** with
`Cmd+,` to change it. A failed connection stays on the settings screen with its
error and a retry button.

Local mode needs Docker Desktop or OrbStack running. The app starts the managed
Postgres container, applies migrations, and prepares the agent sandbox image if
it is missing. The first image build downloads the agent toolchain and can take
several minutes. Projects, settings, and worktrees use `~/.bento` by default, as
the TUI does. Advanced settings allow an existing Postgres URL, another data
directory, or another sandbox image. The local-process option is for trusted
development work only and provides no agent isolation.

Remote mode needs only a Bento server address. HTTPS is required except for a
server on localhost. Sign in through the system browser using Bento's existing
device flow. Agents run on the server. A remote board with local agents is
intentionally excluded.

Provider keys, CLI credential sharing, agent profiles, pipelines, repositories,
projects, team membership, integrations, and account settings remain in the
shared console. Existing beta flags apply exactly as they do on the web.

## Desktop behavior

- The full board, sessions, conversations, run controls, review, diffs, artifacts,
  spending, settings, GitHub, Linear, Slack, and MCP screens come from `apps/web`.
- Repository forms gain a native folder picker in local mode.
- Session and artifact pop-outs open additional Bento windows. External links
  and OAuth flows open the system browser. Downloads use the native save dialog.
- Integration authorization opens the corresponding web settings page. Connect
  there and return to the app, which refreshes the integration's status. Choose
  the same team in the browser when using a shared server. Keeping the entire
  flow in one browser preserves OAuth state cookies and the selected team.
- Native menus provide editing, zoom, full screen, new windows, and navigation.
  Existing web keyboard shortcuts continue to work.
- Native traffic lights sit in the app header, which also drags the window.
  The header has no separate title strip or divider.
  The window background and Connection Settings follow the console's Light,
  Dark, or Dark blue theme. Fullscreen releases the space reserved for controls.
- Closing a window keeps the local server running. **Quit Bento** stops the
  local server gracefully. Remote agents continue independently of the app.
- Connection settings and device tokens are encrypted with Electron safeStorage
  using the macOS login keychain. No plaintext token fallback is used.

## Build an application

```sh
pnpm --filter @bento/desktop... build
# Local Apple Silicon build, without release signing:
pnpm --filter @bento/desktop package:mac --unsigned --dir --arm64
# Local installers for both architectures:
pnpm --filter @bento/desktop package:mac --unsigned --arm64 --x64
```

Outputs are in `release-dist/desktop`. An unsigned local build is for testing;
release distribution needs an Apple Developer ID certificate and notarization.
The installed app bundles its Node runtime, production dependencies, migrations,
web assets, and sandbox Dockerfile. It does not need the source checkout or a
separate Node installation. Docker is still required for local sandboxes.

For a signed release, provide electron-builder's `CSC_LINK` and
`CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`, then omit `--unsigned`. To update an installed app, replace it
with a newer Bento.app. Its connection settings and project data are kept.

### Shared release version

The TUI and Electron app use one Bento version, taken from the Git release tag.
Pushing `v0.1.3`, for example, stamps both applications as `0.1.3`. The Release
workflow builds the CLI archives and Electron installers, verifies them, and
publishes them together with SHA-256 checksums. It no longer packages `apps/mac`.
Both builds must succeed before the release is published.

For local release packaging, use the same tag passed to `scripts/package-cli.mjs`:

```sh
BENTO_RELEASE_TAG=v0.1.3 pnpm --filter @bento/desktop package:mac --unsigned --arm64 --x64
```

Without `BENTO_RELEASE_TAG`, local packaging uses `git describe`, including the
commit and dirty state, as the source TUI does. A source archive without Git
metadata falls back to the package version with a `-dev` suffix. Package manifest
versions are development placeholders; release tags are the source of truth.

The Desktop workflow is also available manually. Select an existing release tag
to rebuild that revision and upload installers as workflow artifacts without
publishing a release. Both workflows use the same packaging job. Signing and
notarization are enabled when `DESKTOP_CSC_LINK` is configured, with
`DESKTOP_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. The existing `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`,
`MACOS_APPLE_ID`, `MACOS_NOTARY_PASSWORD`, and `MACOS_TEAM_ID` secrets are also
accepted. Without a certificate, the job builds unsigned installers.

Fully quit Bento with `Cmd+Q` before opening a rebuilt app. Closing its window
leaves the old process running, including its original native window frame.
Set `BENTO_DESKTOP_OUTPUT` to another output directory when packaging beside an
app that is currently running.

## Verification

```sh
pnpm --filter @bento/desktop test
pnpm --filter @bento/desktop typecheck
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app pnpm --filter @bento/desktop test:e2e
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app pnpm --filter @bento/desktop test:auth
```

The integration scripts launch actual Electron windows and create isolated
temporary databases and profiles. They verify server startup, migrations, card
creation read back from Postgres, streaming, artifact script isolation, native
downloads, shared routes, real device authorization, organization selection,
local preferences across restart, saved login, and sign-out. They remove their databases and leave screenshots in
the temporary directory printed in the output. They do not use paid model APIs.

Set `BENTO_DESKTOP_EXECUTABLE` to an absolute path to
`Bento.app/Contents/MacOS/Bento` to run the same checks against a packaged build.
Set `BENTO_DESKTOP_SANDBOX=docker` to verify startup with Docker sandboxes.
`BENTO_DESKTOP_PROFILE` selects a separate profile for manual development.

## Security and architecture

The Electron session serves bundled console assets at the selected API's origin.
API requests stream to that server, so existing relative links, authentication,
SSE, uploads, downloads, and MCP addresses keep their browser behavior. Device
tokens are attached only to API requests from the trusted console origin.
Opaque artifact frames and foreign pages cannot borrow the user's token.
The installed console's version is independent of the server's web build.

All windows use renderer sandboxing, context isolation, and disabled Node
integration. The console preload exposes only a folder picker, connection
information, connection settings, and browser integration settings. Every IPC call validates the owning
window, main frame, and URL. Agent HTML retains `sandbox="allow-scripts"` and
`srcdoc`, with no `allow-same-origin`. An additional unprivileged preview document
lets artifacts load external scripts without loosening the console's script policy.
Artifact API response sandbox and nosniff
headers are preserved. The local server runs in a separate utility process and
uses the existing access checks, RLS, queue, run-start locks, and artifact store.
Local startup reserves its previous loopback port before starting the server,
preserving browser preferences and supplying the correct OAuth and MCP origin.
If another process has taken that port, it chooses a free one.
