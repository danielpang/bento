# Bento for macOS

Shared web console plus embedded Bento server. Replaces the older Native SDK app in `apps/mac`.

## Run from source

Node **22.19+**, pnpm **9.15.4**:

```sh
pnpm install
pnpm dev:desktop
```

Pick **On this Mac** or **Connect to a server**. The choice persists across launches. **Bento → Connection Settings** (`Cmd+,`) to change it; failures stay on that screen with retry.

| Mode | Needs |
| --- | --- |
| Local | Docker Desktop or OrbStack. App starts Postgres, migrates, builds sandbox image if missing (first build can take several minutes). Data in `~/.bento` by default; optional custom Postgres, data dir, or sandbox image. `local-process` is dev-only (no isolation). |
| Remote | Server URL only. HTTPS except localhost. Sign in via system browser (device flow). Agents run on the server. Remote board + local agents is not supported. |

Everything else (keys, agents, pipelines, repos, team, integrations) is the same shared console as the web, including beta flags.

## Desktop behavior

- Board, sessions, settings, GitHub/Linear/Slack/MCP: `apps/web` UI unchanged.
- Local mode: native folder picker on repository forms.
- Pop-outs and external/OAuth links: system browser. Downloads: native save dialog. Integrations: connect in the browser (same org on shared servers), then return; the app refreshes status.
- Native menus (edit, zoom, fullscreen, windows). Web shortcuts still work.
- Traffic lights in the header (also the drag region). Theme follows console Light / Dark / Dark blue.
- Close window: local server keeps running. **Quit Bento**: stops local server gracefully. Remote agents are unaffected.
- **Updates:** unsigned builds → **Check for Updates** opens a newer stable DMG in the browser; replace `Bento.app` manually after quitting. Signed releases → background check every 6h; **Restart to Update** when ready (local server stops on restart; **Later** keeps it up).
- A bottom-left toast offers **Download update** or **Restart and update**, with a dismiss button. Both packaged modes check after launch and every six hours; unsigned builds only download after consent. Dismissing hides that version across windows for the app session.
- Device tokens: encrypted in the macOS Keychain. No plaintext fallback.

## Build

```sh
pnpm --filter @bento/desktop... build
pnpm --filter @bento/desktop package:mac --unsigned --dir --arm64
pnpm --filter @bento/desktop package:mac --unsigned --arm64 --x64
```

Output: `release-dist/desktop`. Bundled Node, deps, migrations, web assets, sandbox Dockerfile. Host Node not required; Docker still needed for local sandboxes. Packaging builds the Finder icon from `assets/icon.png` with macOS `sips` and `iconutil`, including the small list-view sizes.

Unsigned: manual install/update. `--unsigned` applies an ad-hoc signature to seal the finished app, with hardened runtime disabled only for this mode. It does not establish a trusted developer identity or notarize the app, so Gatekeeper still blocks first launch ([Apple guidance](https://support.apple.com/en-us/102445)). Signed: set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` and omit `--unsigned`. Auto-updates only with `BENTO_RELEASE_TAG` and valid Developer ID signature.

Quit before replacing the app. Launch from `/Applications`, not the mounted DMG.

For a local unsigned build or an older release without Developer ID signing, try opening the installed app, then use **System Settings → Privacy & Security → Open Anyway** if macOS offers it. If it still blocks a download you trust, first compare the DMG's SHA-256 with the release's `SHA256SUMS`. You can then remove quarantine from just your installed Bento copy:

```sh
xattr -dr com.apple.quarantine /Applications/Bento.app
```

This is an explicit exception for Bento. It does not disable Gatekeeper for other apps. Managed Macs may require administrator approval. A matching download checksum does not repair an invalid app signature; use a release built with this packaging fix.

### Versioning and CI

TUI and desktop share the release tag (e.g. `v0.1.3` → `0.1.3`). Release workflow ships CLI + Mac installers + checksums (no `apps/mac`). Local packaging:

```sh
BENTO_RELEASE_TAG=v0.1.3 pnpm --filter @bento/desktop package:mac --unsigned --arm64 --x64
```

Without `BENTO_RELEASE_TAG`, version comes from `git describe` (or `-dev` without Git). Manual **Desktop** workflow can rebuild a tag to artifacts only.

Signing secrets: `DESKTOP_CSC_LINK` / `DESKTOP_CSC_KEY_PASSWORD` (or legacy `MACOS_*`). Both CI workflows require Developer ID signing and notarization. Missing credentials fail before building, and publication rejects unsigned artifacts. `--unsigned` remains available for local testing.

### Apple signing and automatic updates

Automatic installation requires an Apple Developer Program membership and a **Developer ID Application** certificate with its private key. A `.cer` alone is insufficient. Create the CSR in Keychain Access, issue the certificate through your Apple developer account, then export the certificate and private key together as a password-protected `.p12`. See [Apple's CSR instructions](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/) and [electron-builder's macOS signing guide](https://www.electron.build/v26/docs/mac/).

Configure these repository Actions secrets before running the Desktop or Release workflow:

| Actions secret | Value | Local build environment variable |
| --- | --- | --- |
| `DESKTOP_CSC_LINK` | Base64 contents of the exported `.p12` | `CSC_LINK` (base64 or a local `.p12` path) |
| `DESKTOP_CSC_KEY_PASSWORD` | Password protecting the `.p12` | `CSC_KEY_PASSWORD` |
| `APPLE_ID` | Apple account used for notarization | `APPLE_ID` |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated for that account | `APPLE_APP_SPECIFIC_PASSWORD` |
| `APPLE_TEAM_ID` | Developer team that owns the certificate | `APPLE_TEAM_ID` |

Incomplete credentials, signing errors, or notarization errors fail the build. The workflow verifies the Developer ID signature, expected team, notarization staple, and Gatekeeper acceptance on both architectures, then checks every updater asset's size and SHA-512 checksum before upload. An Apple Development or Mac App Store certificate is not a substitute for Developer ID Application.

Signing and notarization remove the unidentified-developer and unverified-malware blocks. macOS can still display its normal first-launch confirmation for an app downloaded from the internet. See [Apple's Gatekeeper guidance](https://support.apple.com/en-us/102445).

Run the **Desktop** workflow on a tag first to validate signing and notarization without publishing a release. Keep the application ID and signing team consistent across releases so macOS can verify the replacement. An existing unsigned app must be replaced manually with the first signed release; later signed releases can update automatically. [electron-builder requires macOS signing and the ZIP update target](https://www.electron.build/v26/docs/features/auto-update/).

### Update artifacts

Public `danielpang/bento` releases; no token; stable only. Manual mode opens DMG URL in browser. Signed auto-updates use `latest-mac.yml`, both arch ZIPs + blockmaps + DMGs + `SHA256SUMS`. Package both arch in one command. Release workflow uploads a draft then publishes. Do not mutate published update files.

`bentoUpdateMode`: `manual` (unsigned), `automatic` (tagged signed), `disabled` (signed, no tag).

`Cmd+Q` before testing a rebuilt app (closing the window leaves the old process). `BENTO_DESKTOP_OUTPUT` for alternate output dir while another instance runs.

## Verification

```sh
pnpm --filter @bento/desktop test
pnpm --filter @bento/desktop typecheck
pnpm --filter @bento/desktop test:updates
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app pnpm --filter @bento/desktop test:e2e
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app pnpm --filter @bento/desktop test:auth
```

E2E: launches the real app, temp DB/profile, server/migrations/cards/SSE/auth/preferences; no paid APIs. Update smoke (macOS): loopback fixture, real updater/controller, consent, arch paths, checksum/metadata errors; set `BENTO_DESKTOP_EXECUTABLE` for the packaged update menu, toast themes, and dismissal across windows. CI runs this against the signed package and checks automatic download plus restart consent. Local unsigned packages exercise manual downloads. Fixture bytes are never installed by Squirrel.

After packaging both arch:

```sh
node apps/desktop/scripts/verify-update-artifacts.mjs release-dist/desktop v0.1.3
```

Signed end-to-end update still needs two real signed releases (install old → download new → **Later** → **Restart to Update**).

Env: `BENTO_DESKTOP_EXECUTABLE` → `Bento.app/Contents/MacOS/Bento`; `BENTO_DESKTOP_SANDBOX=docker`; `BENTO_DESKTOP_PROFILE` for isolated dev profile.

## Security and architecture

Console is served at the API origin; API traffic proxies to that server (cookies, SSE, MCP URLs unchanged). Device token only on API requests from the trusted console origin.

The console runs in a hardened web view with a minimal native bridge (folder picker, connection settings, browser integration). Agent HTML previews stay sandboxed (`allow-scripts` only, no `allow-same-origin`). The local server runs in a separate background process with the same access checks, RLS, queue, and artifact rules as hosted. Local startup prefers the previous loopback port for OAuth/MCP origin; otherwise picks a free port.
