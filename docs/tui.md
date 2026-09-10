# Bento in the terminal

## Install

### From a release

Push a version tag (`v*`) on `main` to publish a CLI tarball and install script on [GitHub Releases](https://github.com/danielpang/bento/releases).

```sh
curl -fsSL https://github.com/danielpang/bento/releases/latest/download/install.sh | bash
```

Pin a version:

```sh
curl -fsSL https://github.com/danielpang/bento/releases/download/v0.1.0/install.sh | bash
```

Requires **Node.js 22+**. The packaged CLI is a self-contained Node app (no pnpm or monorepo checkout on the target machine).

Install location:

| Condition | Path |
| --- | --- |
| Writable `/usr/local` or run as root | `/usr/local/lib/bento`, symlink `/usr/local/bin/bento` |
| Otherwise | `~/.local/lib/bento`, symlink `~/.local/bin/bento` |

Override with `BENTO_INSTALL_DIR` and optional `BENTO_BIN_DIR`.

Manual install from the release assets:

```sh
tar -xzf bento-cli-v0.1.0.tar.gz
sudo mv bento-v0.1.0 /usr/local/lib/bento
sudo ln -sf /usr/local/lib/bento/bento /usr/local/bin/bento
```

### From source (development)

From a clone of this repository:

```sh
pnpm install
./scripts/dev-cli.sh --help
```

`scripts/dev-cli.sh` rebuilds workspace dependencies and runs the CLI through `tsx`.

Opening the TUI shows Bento's orange-and-blue box logo and terminal wordmark while
the local stack starts or the server connects. It adapts to smaller terminals and
uses plain text with screen readers. The board opens as soon as it is ready.

## Where the board and agents run

Three combinations. Pick one before your first `bento setup`.

### Local stack

Everything on this machine: Postgres, API server, board, and agents in Docker sandboxes.

```sh
bento
bento setup
```

Requires **Docker** for agent sandboxes (default driver). Without Docker you can pass `--sandbox local-process` for development only; agents then run on the host with no isolation.

Optional flags: `--data-dir`, `--db`, `--port`, `--share-agent-auth`. Run `bento --help` for the full list.

To use your existing Claude Code subscription, sign in with `claude auth login`, then open Settings → Local agent sign-ins and press `s` to enable sharing. Bento remembers this choice, and the next run can use the login without an Anthropic API key. Sharing is off until enabled. Starting local Bento with `--share-agent-auth` also enables and saves sharing, and you can turn it off in Settings without restarting. Later launches without the flag retain your last saved choice; passing the flag again enables sharing again. An explicit `BENTO_SHARE_AGENT_AUTH` environment variable still pins sharing unless the CLI flag takes precedence.

To attach to an existing local server instead of starting an embedded stack:

```sh
bento --server http://localhost:4400 --project "My project"
```

The same `--project` option selects the project in `bento setup`.

### Remote hosted server (agents on the server)

Use a team server where agents run in hosted sandboxes (for example [usebento.ai](https://usebento.ai) with Fly Sprites). Your machine is a thin client: board state, transcripts, and agent runs stay on the server.

```sh
bento login --server https://your-bento-url
bento --server https://your-bento-url --project "My project"
```

Sign in once per machine. Multi-mode servers require an account and organization; local mode does not.

Agent credentials and repository access are configured on the server (console or `bento setup` while pointed at that URL). You do not need Docker on your laptop for this mode.

Headless agent execution on the server without the board UI is not the default here; use the web console or the board command above.

### Remote server, local agents

Shared board on the server, but agents run in Docker on your machine against local checkouts.

```sh
bento login --server https://your-bento-url
bento --server https://your-bento-url --run-agents local --project "My project"
```

Requires **Docker** on your machine. Runs queue when this machine is offline. The server cannot publish from your local worktrees; use a server-side agent run when you need GitHub publish and PR flows.

Keep a runner process up to execute queued work without opening the board:

```sh
bento runner --server https://your-bento-url
```

---

Run `bento --help` for subcommands (`setup`, `repos`, `agents`, `pipeline`, and others) and all flags.

The board opens in Kanban view, with a column and card count for Backlog, each pipeline stage, and Completed. Wide terminals show all columns; narrower terminals scroll horizontally with the focused stage. Each column scrolls its cards independently, and empty stages remain visible. The selection stays attached to a card when it moves between stages. Click **Sessions** or press `v` (also `e`) to browse project sessions. Selecting a session opens its conversation directly; Back returns to Sessions. Empty projects still expose projects, settings, sessions, and spend.

In terminals that support mouse reporting, click a card to select it and double-click to open its conversation. The wheel moves through cards in the column under the pointer; horizontal scrolling or Shift+wheel changes stages. Clicking an empty column focuses it. Selecting a visible card keeps its position steady, and columns retain their scroll position.

Mouse controls are available throughout the TUI:

- Click the board toolbar to open commands, projects, settings, card creation, Sessions, or quit.
- Click menu and settings rows to open them. Use the wheel to move through long lists, and Back to return. Settings expose buttons for editing, renaming, gates, requirements, automatic PRs and removal where available.
- Click inside an editor to place the cursor, including masked fields. Wheel through multiline drafts and click Submit or Cancel. Validation and typed confirmations still apply.
- Scroll conversations, diffs and other readers with the wheel. Use Find, Next, Top and Bottom to navigate. Follow resumes live conversation output, and Message opens the composer.
- Pan artifact previews with the wheel and use Zoom in, Zoom out, Fit and Back.
- Sign-in and browser handoffs expose buttons to open the displayed page. Error screens offer recovery and exit controls.

Most terminals let you hold Shift to select terminal text instead of sending mouse clicks. The TUI uses the alternate screen and restores the shell screen and mouse mode on exit. Mouse reporting pauses while setup hands the terminal to an external sign-in command. Piped output and screen-reader mode do not enable mouse reporting. Keyboard navigation remains available alongside mouse controls.

| Key | Action |
| --- | --- |
| `←/→` or `Tab` / `Shift+Tab` | Move between Kanban stage columns |
| `↑/↓` or `j/k` | Select a card within the focused column, or move through the list |
| `g/G` | First/last card in the focused Kanban column |
| `v`, `e` | Open project sessions |
| `:` or `Ctrl+P` | Search commands and card actions |
| `/` | Find a card by title or description, including completed cards |
| `p` | Switch, create, rename, or delete projects |
| `,` | Configure the selected project's repositories, stages, and agents |
| `Enter` | Open the full conversation with live output |
| `n` | Create a card with a title and optional multiline description |
| `s` | Start the stage's agent, or choose an agent if none is assigned |
| `c` | Message the agent, or choose an agent for its first run |
| `x` | Stop the selected card's active run |
| `a`, `R`, `r` | Approve or advance, reject with a reason, recheck requirements |
| `b`, `f`, `D` | Send back or reopen, mark done, confirm deletion |
| `d`, `h` | Read the complete diff or activity history |
| `u` | Spend and completion history |
| `?` | Find keyboard help in commands |
| `Esc`, `q` | Return from a view, quit from the board |

In menus, type to filter and use arrows to select. In readers, `PgUp` and `PgDn` page, `g` and `G` jump to the beginning or end, `/` searches, and `n` finds the next match. Conversations follow output until you scroll back. `G` resumes following; `c` composes a message.

The reply box stays below the conversation, so previous messages remain visible while you type. Press `c` or Tab, or click the box, to focus it. Enter sends; `Ctrl+J` adds a newline. Tab, Escape or History returns focus to the transcript without clearing the draft. While typing, shortcut letters are ordinary text; you can still scroll history with the mouse. Sending stays in the conversation and reports whether the message was queued or delivered. Failed sends preserve the draft, and artifact browsing preserves it too. The board's `c` shortcut opens this same inline composer.

Select text using your terminal and use its normal copy and paste shortcuts (Cmd+C and Cmd+V on macOS). While mouse reporting is enabled, your terminal may require Option-drag or Shift-drag to select text. Click the reply box before pasting. Bracketed paste preserves newlines and never submits the message. There are no dedicated clipboard buttons or shortcuts in the composer. Clipboard images must be saved to a file and attached by pasting its path.

Drop or paste quoted file paths into the conversation to attach their contents. Attached filenames appear above the editor; Remove removes the last attachment. Up to three files are allowed, with a 5 MB limit per file and 8 MB total. Files are copied into the card's existing agent workspace when you send, and the message tells the agent where to read them. Image interpretation depends on the agent's image-reading tools and model. A card must already have an agent workspace; attachments last with that workspace. Attachments are enabled locally and for beta testers on shared servers. Copy/Paste text works in either mode.

Opening a card shows its conversation, with bordered sections, distinct user and agent messages, stage markers, and live replies. Consecutive tool calls collapse into a clickable Tool calling… row (Tool calls when finished). Collapsed groups show an animated spinner while tools are running. Animation stops when the calls finish or the group is expanded. Click the group to expand the calls, with file paths, search terms and commands instead of internal tool names. Click a call for its recorded inputs, results and Copy action. Start and finish events share one entry, and failed calls are counted even while collapsed. Press `a` or click Artifacts to browse generated files by stage. Wide terminals show all artifacts in a flat sidebar file list. Click a file to open its actions. Long lists scroll with the mouse wheel or arrow buttons. The Artifacts button retains browsing by stage. Each stage lists its text, image, HTML and diagram artifacts with the existing read, preview and save actions. Empty stages are labeled, and returning from an artifact restores your conversation reading position.

Editors support left/right arrows, Home/End, `Ctrl+A/E`, `Ctrl+W` to delete a word, and `Ctrl+U/K` to clear before or after the cursor. Multiline fields also support up/down arrows and `Ctrl+J` for a newline. Pasting never submits a form. In a multi-field form, Tab or Shift+Tab moves between fields and buttons; Enter advances to the next field or activates the focused button. `Ctrl+S` submits the complete form. A single-field form also submits with Enter. Escape cancels. Failed saves preserve the draft for retry.

New cards show title and description together, with one Create card button. The
same form layout is used for related cards, project creation, repository commands,
Git identity, agent fields, organization creation, invitations, sales requests and
MCP configuration. Click a field to edit it directly. Choice pickers preserve the
rest of the draft. Forms adapt to terminal size and keep their action buttons
available. Project creation can leave the repository blank and connect it later.

Configure agents through **Settings → Agents → select an agent**. The editor contains its name, harness, model and prompt (SKILL.md). You can edit the prompt, load a local SKILL.md file, or clear it. Extra CLI arguments are under Advanced options. Save changes applies the complete draft; Cancel discards it. Agent YAML import and export are also inside Agents. The command palette and Integrations no longer have a separate agent prompt editor.

Agent prompts open at the beginning in an editor that uses the terminal height.
Shorter skills are visible in full. Use `PgUp`/`PgDn` for longer skills and
Home/End to jump to the beginning or end. The editor adapts when you resize the
terminal and keeps Apply to draft and Cancel visible. Enter applies the text to the agent
draft; Save changes then saves the agent.

Model provider keys display provider names and masked key hints in aligned columns.
Configured values are green; missing values say `not set`.
Git identity shows author name and email in one form. Click either field or use Tab
to switch, then Save (or `Ctrl+S`) to apply both values together. Cancel discards
unsaved edits, and a failed save keeps both fields available for retry.

Repository commands separate **Install dependencies (before work)** from **Build and test (after edits)**. Leave dependency setup blank to let the agent inspect the repository instructions, manifests and lockfiles and install what it needs inside the sandbox. Explicit setup runs once per sandbox. If it fails, the agent receives the command and error output and can repair the environment. Simple build-only commands such as `turbo run build` are treated as checks after edits; compound setup scripts keep their explicit behavior. The agent runs checks before reporting completion so it can fix failures. These are agent instructions, not a separate server-enforced build gate. Use the repository's package manager for local tools, for example `pnpm run build` instead of assuming `turbo` is globally installed.

Settings is the single entry point for configuration. Pipeline contains stage names, agents, prompts, advancement, requirements, automatic PRs, ordering and pipeline import/export. MCP is a top-level entry with the same featured catalog as the web UI, configured servers, catalog search and custom server setup. Catalog additions are personal connections, and already-added entries open their settings. Integrations contains GitHub, Linear and, on team servers, Slack. GitHub App connections and personal access tokens share the same GitHub screen. Team, Account and Billing are direct Settings entries on team servers. Local agent sign-ins contains this machine's coding-tool login status and credential-sharing controls; local Git commit identity has its own Settings entry. Back from these sections returns to Settings.

## Web feature coverage

The table distinguishes terminal workflows from browser handoffs. Browser handoffs display an address to open. They do not transfer the CLI's bearer token to a URL.

| Web workflow | Terminal access |
| --- | --- |
| Project selection and CRUD | `p`; `--project` also applies to the board and setup |
| Repository setup/test commands, adding/removing repositories | Settings → Repositories |
| Agent tool/model/name CRUD and provider credentials | Settings → Agents; Settings → Model provider keys |
| Agent prompt (SKILL.md) and extra CLI arguments | Settings → Agents → select an agent; CLI arguments are under Advanced options |
| Pipeline stages, assignments, gates, criteria, automatic PRs | Settings → Pipeline → select a stage |
| Stage descriptions and order | Settings → Pipeline → select a stage |
| Agent and pipeline YAML import/export | Settings → Agents → Import or export agents; Settings → Pipeline → Import or export pipeline |
| Card creation, description, search, status, movement and deletion | Board keys and commands |
| Related cards and creating parts | Commands, for beta testers only |
| Start, stop, message, resume and checkpoint rollback | Board, conversation and run history |
| Live output, completed conversations and pending messages | Enter; earlier runs remain accessible through run history |
| History and gate results | `h`; commands: gate requirements and results |
| File changes and stage write-ups | `d`, with complete server-provided diff and a truncation notice when applicable |
| Artifacts | Commands: browse artifacts, read source, save authenticated bytes to a new file |
| HTML/image/diagram previews | Artifacts: readable HTML, image/diagram zoom, and Open in browser |
| Publish/link PRs, PR history, merge/CI status, conflict and CI repair | Commands |
| Sessions, spend per card/stage/agent, completion windows | `e`, `u` |
| GitHub App installation and existing installations, PR notes | Settings → Integrations → GitHub |
| Linear credentials, mappings, issue import, sync, destinations | Settings → Integrations → Linear |
| Slack connection and default project | Settings → Integrations → Slack, in multi mode |
| MCP catalog, server toggles, keys, account connection and removal | Settings → MCP |
| Inbound MCP tokens and revocation | MCP: agents connected to Bento, for beta testers only |
| Advanced MCP authentication configuration | MCP: custom servers, transport, auth method, sharing scope, headers, OAuth clients and automatic registration |
| Local Git commit identity and subscription credential sharing | Settings → Git identity; Settings → Local agent sign-ins |
| Team membership and invitations | Settings → Team: organizations, invite/accept/decline/cancel, roles, removal and network policy |
| Hosted billing | Settings → Billing: plan comparison, checkout, usage by card/member, billing activity, overage policy and spending limits, sales contact |
| Account management | Settings → Account: profile, sign out, organization deletion and account deletion request |
| OAuth approvals and GitHub identity linking | Browser handoff |
| Web appearance preferences | Remain web-specific; terminal colors follow its ANSI palette |
| Changelog | Commands: read the changelog in browser |

Team, account, billing, MCP authentication and visual previews have native terminal workflows. Payment entry, invoices, subscription cancellation, OAuth authorization and email confirmation still use their secure provider or verification pages. Hosted billing is supplied by a deployment extension and is absent in local mode. External service mutations require their respective connections and permissions.

Organization switching clears the previous board, profiles, transcript and feature flags before loading the new team. The last owner cannot be removed or demoted. Deleting an organization requires typing its name. Account deletion checks ownership across every organization before requesting the verification email. Invitations show the prorated seat cost before confirmation, and a failed pricing request prevents submission.

Billing changes require explicit confirmation. Checkout also requires a choice between stopping at the included allowance and paying for overage. Enterprise uses the sales workflow. Failed requests preserve the current form for retry.

## Artifact previews

Images render as terminal color blocks without needing terminal-specific image protocols. Use `+` and `-` to zoom, arrows or `h/j/k/l` to pan, `PgUp/PgDn` to scroll, and `0` to fit. Escape returns to the artifact menu. Source reading and downloads remain available.

HTML opens as readable terminal text with headings, lists, tables and control labels. Text wraps at word boundaries, and Find, scrolling and mouse controls work as in other readers. Image overview provides the static layout when needed. Open browser loads a lightweight viewer at `/api/artifacts/:id/preview`; it does not require the web console or a separate web build. The browser shows the HTML at normal resolution inside a sandboxed frame and supports inline interactions. External requests are blocked. The preview and download both check access to the artifact; browser authentication uses the browser's own session.

HTML and Mermaid previews require Chromium. Install it once with:

```sh
pnpm --filter @bento/tui exec playwright install chromium
```

The terminal renderer uses a fresh browser context without application cookies. HTML scripts, frames and external resources are disabled. Mermaid uses a bundled renderer with strict security and blocked network access. Previews accept up to 10 MB; diagrams are limited to 50,000 characters. The HTML image overview shows the first 6000 pixels; the readable view extracts up to 200,000 characters. Use Open browser for the complete visual page and inline interactions. Terminal rendering has a time limit, and closing the preview cancels the download or rendering.

## Verification

See the [real terminal verification report](./tui-testing.md) for the latest keyboard coverage, runtime fixes, real agent results and remaining integration limits.

Run `pnpm --filter @bento/tui test`, `pnpm --filter @bento/api-client test`, and `pnpm typecheck`. TUI tests report failures through their exit status. Interaction tests cover pasted text, editing, navigation, setup list scrolling, retained failed drafts, card targeting, search parity, and beta visibility. Client tests cover bearer-authenticated board streams, reconnection, rejected tokens, and binary artifact downloads.

Live verification on 2026-09-06 used the built TUI against the local Docker-backed server. A temporary project exercised project/card creation, multiline descriptions, advance, completion, reopening, history, project-scoped setup, agent selection, live output, follow-up messaging, stopping, and project deletion. A real Cursor run returned `BENTO_TUI_OK`; the follow-up run was cancelled from the TUI. API read-back confirmed both run states and zero changed files. Temporary project, card, runs, and agent profile were removed afterward.

A second verification used the built TUI against an isolated multi-mode HTTP server and temporary Postgres database. It exercised bearer sessions, organization creation and switching, invitations, member roles and removal, network policy, OAuth client configuration, organization deletion, account deletion requests and sign out. Database read-back confirmed changes and removal of access. The mailer recorded messages without delivering email. The temporary database and files were removed.

Run `pnpm --filter @bento/tui test:previews` for the real Chromium checks (after installing the browser). These render HTML and Mermaid, check image pixels, and verify that hostile HTML cannot execute scripts or fetch external resources. Settings regressions cover permissions, last-owner protection, failed ownership/pricing requests, spending limits and retaining checkout links after success.

Billing request formats were checked against the cloud deployment source and exercised with response fixtures. Live payment-provider transactions, OAuth provider approvals, GitHub publishing, Linear/Slack mutations and every individual agent adapter were not exercised end to end.

### Pull requests in a conversation

The card sidebar lists pull requests with merge and CI status. Press `p` or click **PRs** to see every pull request, including previous branches from reopened work. Select a PR to see its branch, status and browser link. Status refreshes every 30 seconds while the conversation is open. Status symbols distinguish ✅ no merge conflicts or passing CI, ❌ merge conflicts or failing CI, ⏳ running checks and ❓ unknown status.

Choose **Create or update PRs** to publish committed changes through Bento's GitHub connection. **Automatic PR for [stage]** controls publication after future successful runs in that stage. Agents commit inside the sandbox; Bento's server pushes and opens PRs, so agents do not need GitHub tokens. A successful agent run does not publish automatically when this setting is off.

In PR details, **Fix CI tests** appears for failing CI and **Fix merge conflicts** appears for conflicts. One click starts the stage agent and returns to the conversation. These actions use the same card-wide repair endpoints as the web console, covering affected current PRs. They are disabled while a run is active and hidden for previous branches, closed PRs and finished cards. Request errors stay on the PR page so you can retry.
