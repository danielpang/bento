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
- Signed release builds check for stable updates after launch and every six
  hours, and download them in the background. **Bento > Check for Updates**
  checks immediately. Once downloaded, choose **Bento > Restart to Update**.
  Restart is always your choice. Finish active local work first, because the
  local server stops during restart. Choosing **Later** keeps it running.
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
`APPLE_TEAM_ID`, then omit `--unsigned`. Automatic updates are enabled only when
`BENTO_RELEASE_TAG` is supplied and the packaged app has a valid Developer ID
Application signature. Source, local, and explicitly unsigned builds show an
explanation in **Check for Updates** and never contact the update service.

Existing unsigned builds and builds from before automatic updates were added
need one manual replacement with the first signed release. Drag its Bento.app
into Applications. Connection settings and project data are kept. Subsequent
signed releases update through the app. Launch the installed app from
Applications, rather than from the mounted DMG.

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
notarization require `DESKTOP_CSC_LINK`, with
`DESKTOP_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. The existing `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`,
`MACOS_APPLE_ID`, `MACOS_NOTARY_PASSWORD`, and `MACOS_TEAM_ID` secrets are also
accepted. Missing signing or notarization secrets fail the job explicitly.
Because the CLI and Mac app share one release, this also prevents publication
of that CLI release until signing is configured. Only local commands with
`--unsigned` can opt out of signing.

### Configure the first signing certificate

1. In Keychain Access, use **Certificate Assistant > Request a Certificate From
   a Certificate Authority** to save a CSR. Follow Apple's
   [certificate request instructions](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/).
2. As the Apple Developer account holder, create a **Developer ID Application**
   certificate with that CSR in Certificates, Identifiers & Profiles. Download
   and open the `.cer` file on the same Mac to pair it with its private key.
   See [Apple's Developer ID guide](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
3. From **My Certificates** in Keychain Access, export the certificate together
   with its private key as a password-protected `.p12` file. Store its base64
   representation in the repository's GitHub Actions secret
   `DESKTOP_CSC_LINK`, and its export password in `DESKTOP_CSC_KEY_PASSWORD`.
   Keep the private key and password out of source control and logs.
4. Set `APPLE_ID` to the signing account email, `APPLE_TEAM_ID` to the Developer
   team ID, and `APPLE_APP_SPECIFIC_PASSWORD` to an
   [app-specific password](https://support.apple.com/en-us/102654) for notarization.
5. Build a version tag through the Desktop workflow to verify signing and
   notarization without publishing. The job checks each app's Developer ID
   signature and stapled notarization ticket before accepting its artifacts.

### Update release contract

The pinned electron-updater 6.8.3 uses electron-builder 26's metadata format and
the public `danielpang/bento` GitHub Releases feed. No token is shipped. The
stable channel excludes prereleases and downgrades. Even a prerelease build
checks only stable releases; a higher prerelease waits for a newer stable
version. The explicit `latest` publish channel generates `latest-mac.yml` for
all builds; GitHub's prerelease flag controls stable visibility.

Build both architectures in one invocation so builder merges both ZIPs and
DMGs into `latest-mac.yml`. Keep these release assets together:

- `Bento-{version}-arm64.dmg` and `Bento-{version}-x64.dmg` for installation.
- The matching `.zip` files for Squirrel.Mac, and all `.blockmap` files for
  differential downloads.
- `latest-mac.yml` with SHA-512 hashes and sizes for both architectures.
- `SHA256SUMS` covering the installers, ZIPs, blockmaps, and update metadata.

The updater selects arm64 on Apple Silicon, including a currently running x64
build under Rosetta, and x64 on Intel. It verifies download checksums, then
asks native Squirrel.Mac to validate the update signature after restart
consent. Only successful native staging allows the local server to stop.
The utility process must exit before the app restarts. A failed download or
signature check leaves the current app running and can be retried. Missing
macOS metadata on an older CLI-only release gets a readable retry message.

electron-builder always runs with `--publish never`. The release workflow
validates artifacts and uploads all of them to a draft before publishing it.
Never replace a published release's update files. Use a new version tag.

Fully quit Bento with `Cmd+Q` before opening a rebuilt app. Closing its window
leaves the old process running, including its original native window frame.
Set `BENTO_DESKTOP_OUTPUT` to another output directory when packaging beside an
app that is currently running.

## Verification

```sh
pnpm --filter @bento/desktop test
pnpm --filter @bento/desktop typecheck
pnpm --filter @bento/desktop test:updates
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app pnpm --filter @bento/desktop test:e2e
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app pnpm --filter @bento/desktop test:auth
```

The integration scripts launch actual Electron windows and create isolated
temporary databases and profiles. They verify server startup, migrations, card
creation read back from Postgres, streaming, artifact script isolation, native
downloads, shared routes, real device authorization, organization selection,
local preferences across restart, saved login, and sign-out. They remove their databases and leave screenshots in
the temporary directory printed in the output. They do not use paid model APIs.

The update smoke test needs macOS but no database or signing credentials. It
uses real Electron networking and the installed GitHub provider against a
loopback release fixture. It checks the native menu, stable selection, both
architecture paths (including simulated Rosetta), checksum rejection, missing
metadata, and real graceful and forced utility-process exits. It never installs
an update. Set `BENTO_DESKTOP_EXECUTABLE` to verify the unsigned packaged app's
disabled-update menu as well. After packaging both architectures, run:

```sh
node apps/desktop/scripts/verify-update-artifacts.mjs release-dist/desktop v0.1.3
```

Certificate-backed installation still needs two real signed releases: install
the older app from its DMG, run a local server, download the newer release,
choose **Later** and confirm work continues, then choose **Restart and Update**.
Verify the new About version, restored settings, local server restart, and no
orphan utility process. Repeat on Intel or Rosetta where available. This check
cannot be replaced by unsigned fixtures or ad hoc signing.

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
