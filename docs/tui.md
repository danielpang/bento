# Bento in the terminal

Run `bento --server http://localhost:4400 --project "My project"` to connect to a running server. The same `--project` option selects the project in `bento setup`. Without a server argument, Bento starts its embedded stack. Run `bento --help` for local database and runner options.

The board opens in Kanban view, with a column and card count for Backlog, each pipeline stage, and Completed. Wide terminals show all columns; narrower terminals scroll horizontally with the focused stage. Each column scrolls its cards independently, and empty stages remain visible. The selection stays attached to a card when it moves between stages. Press `v` to switch between Kanban and the compact list for the current session. Empty projects still expose projects, settings, sessions, and spend.

In terminals that support mouse reporting, click a card to select it and double-click to open its conversation. The wheel moves through cards in the column under the pointer; horizontal scrolling or Shift+wheel changes stages. Clicking an empty column focuses it. The list view also supports card clicks, double-clicks and vertical scrolling. Selecting a visible card keeps its position steady, and columns retain their scroll position.

Mouse controls are available throughout the TUI:

- Click the board toolbar to open commands, projects, setup, card creation, the alternate view, or quit.
- Click menu and settings rows to open them. Use the wheel to move through long lists, and Back to return. Settings expose buttons for editing, renaming, gates, requirements, automatic PRs and removal where available.
- Click inside an editor to place the cursor, including masked fields. Wheel through multiline drafts and click Submit or Cancel. Validation and typed confirmations still apply.
- Scroll conversations, diffs and other readers with the wheel. Use Find, Next, Top and Bottom to navigate. Follow resumes live conversation output, and Message opens the composer.
- Pan artifact previews with the wheel and use Zoom in, Zoom out, Fit and Back.
- Sign-in and browser handoffs expose buttons to open the displayed page. Error screens offer recovery and exit controls.

Most terminals let you hold Shift to select terminal text instead of sending mouse clicks. The TUI uses the alternate screen and restores the shell screen and mouse mode on exit. Mouse reporting pauses while setup hands the terminal to an external sign-in command. Piped output and screen-reader mode do not enable mouse reporting. All existing keyboard controls remain available.

| Key | Action |
| --- | --- |
| `←/→` or `Tab` / `Shift+Tab` | Move between Kanban stage columns |
| `↑/↓` or `j/k` | Select a card within the focused column, or move through the list |
| `g/G` | First/last card in the focused Kanban column |
| `v` | Toggle Kanban and list views |
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
| `u`, `e` | Spend and completion history, project sessions |
| `?` | Find keyboard help in commands |
| `Esc`, `q` | Return from a view, quit from the board |

In menus, type to filter and use arrows to select. In readers, `PgUp` and `PgDn` page, `g` and `G` jump to the beginning or end, `/` searches, and `n` finds the next match. Conversations follow output until you scroll back. `G` resumes following; `c` composes a message.

Editors support left/right arrows, Home/End, `Ctrl+A/E`, `Ctrl+W` to delete a word, and `Ctrl+U/K` to clear before or after the cursor. Multiline fields also support up/down arrows and `Ctrl+J` for a newline. Pasting never submits a form. Enter submits and Escape cancels. Failed saves preserve the text for retry.

## Web feature coverage

The table distinguishes terminal workflows from browser handoffs. Browser handoffs display an address to open. They do not transfer the CLI's bearer token to a URL.

| Web workflow | Terminal access |
| --- | --- |
| Project selection and CRUD | `p`; `--project` also applies to the board and setup |
| Repository setup/test commands, adding/removing repositories | Setup |
| Agent tool/model/name CRUD and provider credentials | Setup |
| Agent instructions and extra CLI arguments | Commands: edit agent operating instructions |
| Pipeline stages, assignments, gates, criteria, automatic PRs | Setup |
| Stage descriptions and order | Commands: edit stage instructions and reorder pipeline |
| Agent and pipeline YAML import/export | Setup |
| Card creation, description, search, status, movement and deletion | Board keys and commands |
| Related cards and creating parts | Commands, for beta testers only |
| Start, stop, message, resume and checkpoint rollback | Board, conversation and run history |
| Live output, completed conversations and pending messages | Enter; earlier runs remain accessible through run history |
| History and gate results | `h`; commands: gate requirements and results |
| File changes and stage write-ups | `d`, with complete server-provided diff and a truncation notice when applicable |
| Artifacts | Commands: browse artifacts, read source, save authenticated bytes to a new file |
| HTML/image/diagram visual previews | Artifacts: Preview in terminal, with zoom and scrolling |
| Publish/link PRs, PR history, merge/CI status, conflict and CI repair | Commands |
| Sessions, spend per card/stage/agent, completion windows | `e`, `u` |
| GitHub App installation and existing installations, PR notes | Integrations and account: GitHub |
| Linear credentials, mappings, issue import, sync, destinations | Integrations and account: Linear |
| Slack connection and default project | Integrations and account: Slack, in multi mode |
| MCP catalog, server toggles, keys, account connection and removal | Integrations and account: MCP |
| Inbound MCP tokens and revocation | MCP: agents connected to Bento, for beta testers only |
| Advanced MCP authentication configuration | MCP: custom servers, transport, auth method, sharing scope, headers, OAuth clients and automatic registration |
| Local Git commit identity and subscription credential sharing | Integrations and account: Git author; setup: subscriptions |
| Team membership and invitations | Team: organizations, invite/accept/decline/cancel, roles, removal and network policy |
| Hosted billing | Billing: plan comparison, checkout, usage by card/member, billing activity, overage policy and spending limits, sales contact |
| Account management | Account: profile, sign out, organization deletion and account deletion request |
| OAuth approvals and GitHub identity linking | Browser handoff |
| Web appearance preferences | Remain web-specific; terminal colors follow its ANSI palette |
| Changelog | Commands: read the changelog in browser |

Team, account, billing, MCP authentication and visual previews have native terminal workflows. Payment entry, invoices, subscription cancellation, OAuth authorization and email confirmation still use their secure provider or verification pages. Hosted billing is supplied by a deployment extension and is absent in local mode. External service mutations require their respective connections and permissions.

Organization switching clears the previous board, profiles, transcript and feature flags before loading the new team. The last owner cannot be removed or demoted. Deleting an organization requires typing its name. Account deletion checks ownership across every organization before requesting the verification email. Invitations show the prorated seat cost before confirmation, and a failed pricing request prevents submission.

Billing changes require explicit confirmation. Checkout also requires a choice between stopping at the included allowance and paying for overage. Enterprise uses the sales workflow. Failed requests preserve the current form for retry.

## Artifact previews

Images render as terminal color blocks without needing terminal-specific image protocols. Use `+` and `-` to zoom, arrows or `h/j/k/l` to pan, `PgUp/PgDn` to scroll, and `0` to fit. Escape returns to the artifact menu. Source reading and downloads remain available.

HTML and Mermaid previews require Chromium. Install it once with:

```sh
pnpm --filter @bento/tui exec playwright install chromium
```

The renderer uses a fresh browser context without application cookies. HTML scripts, frames and external resources are disabled. Mermaid uses a bundled renderer with strict security and blocked network access. Previews accept up to 10 MB; diagrams are limited to 50,000 characters. HTML previews show the first 6000 pixels of a static page, so interactive mockups and externally loaded assets need the web viewer. Browser rendering has a time limit, and closing the preview cancels the download or rendering.

## Verification

See the [real terminal verification report](./tui-testing.md) for the latest keyboard coverage, runtime fixes, real agent results and remaining integration limits.

Run `pnpm --filter @bento/tui test`, `pnpm --filter @bento/api-client test`, and `pnpm typecheck`. TUI tests report failures through their exit status. Interaction tests cover pasted text, editing, navigation, setup list scrolling, retained failed drafts, card targeting, search parity, and beta visibility. Client tests cover bearer-authenticated board streams, reconnection, rejected tokens, and binary artifact downloads.

Live verification on 2026-09-06 used the built TUI against the local Docker-backed server. A temporary project exercised project/card creation, multiline descriptions, advance, completion, reopening, history, project-scoped setup, agent selection, live output, follow-up messaging, stopping, and project deletion. A real Cursor run returned `BENTO_TUI_OK`; the follow-up run was cancelled from the TUI. API read-back confirmed both run states and zero changed files. Temporary project, card, runs, and agent profile were removed afterward.

A second verification used the built TUI against an isolated multi-mode HTTP server and temporary Postgres database. It exercised bearer sessions, organization creation and switching, invitations, member roles and removal, network policy, OAuth client configuration, organization deletion, account deletion requests and sign out. Database read-back confirmed changes and removal of access. The mailer recorded messages without delivering email. The temporary database and files were removed.

Run `pnpm --filter @bento/tui test:previews` for the real Chromium checks (after installing the browser). These render HTML and Mermaid, check image pixels, and verify that hostile HTML cannot execute scripts or fetch external resources. Settings regressions cover permissions, last-owner protection, failed ownership/pricing requests, spending limits and retaining checkout links after success.

Billing request formats were checked against the cloud deployment source and exercised with response fixtures. Live payment-provider transactions, OAuth provider approvals, GitHub publishing, Linear/Slack mutations and every individual agent adapter were not exercised end to end.
