# TUI verification, 2026-09-06

## TUI branch publication checks, 2026-09-10

The final working tree includes the inline conversation composer, simplified settings and forms, Sessions navigation, flat artifact sidebar, PR history and repair actions, explicit merge/CI symbols, collapsed tool activity with a running spinner, local CLI authentication, repository setup recovery and base-branch isolation.

Before publishing to `feat/improve-tui`:

- All 22 repository typecheck tasks and all 11 TUI dependency build tasks passed.
- Default suites passed: 106 TUI tests, 100 core tests, 65 agent tests, 11 API-client tests and 78 sandbox tests. The default commands skipped one opt-in browser test and two sandbox integration tests.
- The opt-in Chromium preview suite passed all 3 tests. The disposable Docker execution suite passed all 6 tests, including timeout/cancellation cleanup without stopping unrelated processes. The hosted Sprite suite was not run in this publication pass.
- All 20 focused server tests passed for preview isolation, attachment delivery, Cursor authentication, prompts and editable machine settings.
- Four Postgres lifecycle tests passed for artifact access and repository setup, including failed setup reaching the agent and build checks surviving resumed conversations. The foreign-tenant entity-route matrix passed.
- Recent real terminal checks covered PR details and conditional repair buttons, green/red merge and CI labels, repository command forms, reordered controls, mouse navigation, multiline paste and tool-spinner animation and cleanup. Repair request tests used controlled responses; no repair was started on the user's active card during UI verification.

Earlier sections retain the more detailed live verification records for individual changes.


## Top-level MCP settings and featured servers, 2026-09-08

MCP is a direct Settings entry and no longer appears under Integrations. The opening screen reads the same catalog API as the web UI, shows featured servers and labels entries already added. Catalog additions use personal scope for both members and administrators. Existing entries open their settings, and a catalog outage leaves configured servers and custom setup available.

Six live PTY checks against the local server covered the Settings entry, featured list, catalog browsing, custom form, 60-column layout and removal from Integrations. No servers were added or connected by the live checks. Regression tests cover featured filtering, registry defaults, personal scope, duplicate prevention, catalog failure and root navigation. The TUI build and 89 tests passed, with one optional browser test skipped.

## Shared Bento branding on the board, 2026-09-08

The board header reuses the startup logo and wordmark, with the slogan and project context. It reserves the artwork's height in both Kanban and list layouts. Short, narrow, screen-reader and redirected terminals retain a compact header. Six live PTY checks against the local server covered the artwork, visible footer, list view, 80 by 30 layout, compact 60 by 20 layout and restoration on resize. The TUI build and 87 tests passed, with one optional browser test skipped. The checks only read board data.

## Lightweight artifact viewer and readable HTML, 2026-09-08

The browser action now targets `/api/artifacts/:id/preview`, an authenticated thin wrapper that reads the artifact through `getAccessibleArtifact` and embeds its bytes in an opaque sandboxed iframe. No web console build is required. Raw HTML downloads retain their attachment disposition and sandbox CSP. The route was added to the foreign-tenant matrix, which passed.

Real Chromium against an isolated Bento server rendered a copy of the user's `edit-agent-from-board.html` at normal resolution, without loading console assets. Inline button interactions worked; attempts to modify the parent document or fetch API data were blocked. Missing artifacts returned 404, image bytes rendered and download headers remained intact. Two wrapper tests cover hostile filenames, attribute escaping, image embedding and text escaping. The three real Chromium terminal-preview tests passed, including heading/list/table extraction and script/network isolation.

The built TUI was driven through artifact navigation, readable HTML, Find, first/last scrolling, a 60-column layout and the corrected browser link. Screenshots capture both the browser layout and terminal reader. The TUI suite passed 87 tests with one optional browser test skipped; all 22 typecheck tasks and the TUI build passed. The temporary database and isolated servers were removed after verification.

## Cursor project directory startup fix, 2026-09-08

The failing sandbox mounted the host's entire `.cursor` directory read-only. Cursor 2026.09.02-c22c1a3 then failed with `ENOENT` when creating `/root/.cursor/projects/workspace-bento`. Cursor login sharing now reads the native credential store and forwards the access token or API key, leaving the sandbox home writable. Refresh tokens stay on the host. Disabled sharing and multi mode do not read or forward the host login.

An offline Docker check using the actual Bento adapter and provisioning driver reproduced the exact error with a synthetic credential. Reprovisioning with the fixed mount list automatically replaced the old container. The same Cursor version then created its project directory and reached the deliberately unavailable local endpoint. No real credentials or paid model calls were used. Disposable containers and fixtures were removed. All 25 targeted server tests, 63 agent tests, 22 typecheck tasks and the TUI build passed.

## Clipboard and file attachments, 2026-09-08

The conversation editor supports explicit Copy/Paste controls, Ctrl+V, native clipboard images on macOS, Finder-copied files, dropped or quoted paths, and an inline Attach field. Copy uses the complete draft; pasted text inserts at the caret. Attachment-only messages are accepted. Files are capped, removable, retained on failure and copied into the authorized card workspace before its message is queued. Attachment requests use the existing message access check and beta flag.

Fourteen real PTY checks exercised text paste, Copy dispatch, Ctrl+V, native image clipboard reads, escaped filenames, Finder file entries, removal, small layouts, attachment-only sends, typed paths and caret insertion. The clipboard provider used a private macOS pasteboard and Copy dispatch captured only the fixture draft, leaving the system clipboard unchanged. Three native private-pasteboard checks independently verified macOS text, image and filename reads. Image and file bytes were read back from the isolated agent workspace and matched the originals exactly; the persisted queued message referenced those files. Two server tests exercised the real local process driver and payload limits. The tenant route matrix passed with an attachment-bearing request added to the foreign-card checks. The TUI suite passed 86 tests with one optional browser test skipped, and all 22 typecheck tasks passed. No paid agent run was launched.

## Inline conversation composer, 2026-09-08

Messaging a card now focuses a persistent reply box below its conversation. Keyboard and mouse focus, multiline paste, Enter to send, Ctrl+J for newlines and Escape/Tab back to history keep the transcript mounted. Successful sends show delivery status in place; failures retain the draft. Artifact navigation retains the draft and reading position. The board message shortcut uses the same composer.

Live PTY checks against an isolated server verified simultaneous history and drafting, mouse focus, artifact return, 80-column and compact layouts, live SSE while composing, exact multiline messages persisted once through the real API, empty-send prevention, shortcut isolation and the board entry point. No paid agent was launched. Regression tests cover send failures and retry, rapid duplicate submits, paste without sending, draft restoration, preserving the original card when selection changes and successful sends despite board-refresh failure. The TUI suite passed 83 tests with one optional browser test skipped; all 22 repository typecheck tasks passed.

## Conversation layout and stage artifacts, 2026-09-07

The default card conversation now has bordered header, transcript, action area and wide-terminal artifact sidebar. User and agent turns retain speaker labels, stage boundaries and readable word wrapping. Tool details expand on demand. Stage menus include empty stages and retain artifacts from removed stages; returning from an artifact restores the conversation position.

Twenty real PTY checks against an isolated local server and Postgres verified conversation opening, role styling, tool details, search, mouse scrolling, the reply action, stage counts, empty stages, reading the correct artifact, wide and narrow layouts down to 40×12 and 30 columns, and restoring history position. Fixture events persisted in Postgres and delivered through the real SSE endpoints verified live drafts, replacement by completed messages, completion without duplication, and new stage artifacts appearing after completion. No paid agent was launched. The TUI suite passed 81 tests with one optional browser test skipped, and all 22 repository typecheck tasks passed. A pre-existing stage-editor test now waits for the refreshed menu before sending Escape, eliminating its save/navigation timing race.

## Local Claude login sharing, 2026-09-07

Embedded startup leaves sharing unchanged when the flag is omitted. An explicit `--share-agent-auth` saves an initial opt-in without locking Settings. Settings report effective sharing, including explicit environment overrides, instead of the saved value alone. A real embedded server with an isolated Postgres database verified saved opt-in, editable CLI choices, live setting changes, macOS Keychain credential resolution without printing credentials, and multi-mode exclusion. A real PTY session launched with the flag and previously disabled sharing, recognized Claude Max, and toggled sharing off and on without restarting. A subsequent launch without the flag preserved the last TUI edit. No paid agent run was launched, and the isolated database and settings were removed. Thirteen focused server tests passed. The TUI suite passed 74 tests with one optional browser test skipped on rerun after an initial stage-editor navigation timeout; all 22 repository typecheck tasks passed.

## Shared forms and card creation, 2026-09-07

New and related cards show title and description together. A shared Form component supplies field focus, choice pickers, multiline editing, masked fields, validation, explicit submission and cancellation. Git identity, project creation, repository commands, agent fields, organizations, invitations, sales requests and MCP configuration use the same form behavior. Confirmation steps remain for invitations, billing and credential replacement.

Twenty-six live PTY checks drove the built CLI against isolated local and team servers. They verified complete card creation and cancellation, keyboard and mouse focus, 40×12 layouts, repository command persistence, project creation with and without a checkout, organization creation, invitation role selection without sending, MCP creation and edit fields, conditional OAuth sharing controls, and draft retention while opening pickers. API reads verified the stored values. External invitations, sales messages and OAuth approvals were not sent. The TUI suite passed 73 tests with one optional browser test skipped; all 22 repository typecheck tasks passed. Regressions cover failed card creation, avoiding duplicate creation after a refresh failure, related-card parenting, optional repositories, draft retention through pickers, masking, and required-field validation.

## Git identity and provider key columns, 2026-09-07

Git identity now shows name and email together with one explicit Save action. Provider names and masked key hints occupy aligned columns, with configured values green. Twelve live PTY checks covered status-column alignment at 120 and 40 columns, opening a masked key editor by clicking its status, editing both identity fields without premature writes, clicking an inactive field to position the caret, saving both values, reading back the actual isolated settings file, Cancel, keyboard submission, and a 40×12 form. The build and 68 tests passed, with one optional browser test skipped. Regression tests cover atomic form submission, failed-save draft retention and cancellation. Isolated servers, data files and the temporary database were removed after verification.

## Expanded agent prompts, 2026-09-07

Agent prompt editing now uses the available terminal height and starts at the beginning of the skill. Live PTY checks against an isolated server and Postgres verified an entire 18-line skill visible at 120×36, mouse cursor placement on line 10, complete saved-text read-back, an 80-line paste, Page Up/Down, Home/End, resizing to 40×12 with both action buttons visible, and cancellation without changing the saved skill. The build and 65 TUI tests passed, with one optional browser test skipped. Regression tests cover full-draft preservation and paging through wrapped paragraphs.

## Startup artwork, 2026-09-07

The built CLI displayed the Bento box logo and wordmark against the live isolated server at 120×36 and 66×13, the compact logo at 40×12, and a text title at 20×8. Each session reached the board and quit normally. Screen-reader and dumb-terminal sessions used plain startup text and reached the board. Help and version output contained no artwork. Captures came from real PTY output. The TUI build and 63 tests passed, with one optional browser test skipped.

## Settings consolidation, 2026-09-07

Settings is now the single configuration hub. Pipeline owns stage prompts, agents, names, advancement, requirements, PR preferences, ordering and import/export. Integrations owns GitHub, Linear, Slack and MCP; the separate GitHub token and basic MCP editors were removed. Team, Account and Billing open directly from Settings on team servers. Local agent sign-ins contains machine login status and credential sharing.

Seventeen checks drove the built CLI with keyboard and mouse events against an isolated HTTP server and temporary Postgres database. API read-back verified stage prompt/name/agent changes, automatic advancement and command requirements, PR preferences, ordering, creation and deletion. Exported YAML retained the edited prompt. Navigation checks covered GitHub, MCP, Team, Account, Billing, removal of duplicate command entries, and returning to Settings. GitHub token input stayed masked and was cancelled. A 40×12 terminal retained usable stage prompt controls.

The TUI suite passed 63 tests with one optional browser test skipped. All 22 repository typecheck tasks passed. New regressions cover stage editing, clearing legacy manual criteria when selecting automatic advancement, preserving concurrently added stages during reordering, hub organization, local sign-in/sharing controls and GitHub credential permissions. External provider approvals and payments were not performed. The temporary server, database and authentication fixture were removed after verification.

## Mouse support across the TUI

The built CLI now supports mouse controls in menus, setup, forms, conversations, readers, artifact previews, sign-in and recovery screens, as well as both board views. Live checks used real SGR input in pseudo-terminals against an isolated HTTP server and temporary Postgres database.

The checks exercised command filtering and exact row selection; card creation and deletion cancellation/confirmation; cursor placement; multiline Unicode persistence; stage assignment and rename; settings scrolling; conversation history, following and draft cancellation; HTML preview zoom, pan and fit; project switching; and menus and readers at 80×24, 60×16 and 40×12. A forty-line paste at 60×16 retained visible Submit and Cancel buttons and saved exactly. A masked field stayed masked during pointer editing and cancellation. Clicking Submit without typing `confirm` could not bypass confirmation.

Sign-in checks requested a fresh device code through Try again and exited through Quit. A temporary localhost proxy verified mouse Retry after an unavailable server. The existing 21 board mouse checks passed again, along with Ctrl+C, SIGTERM and screen-reader lifecycle checks. The TUI suite has 54 passing tests and one opt-in browser test skipped; all 22 repository typecheck tasks passed. Real Chromium rendered the HTML preview during the live mouse checks.

Regression coverage includes nested button routing, preventing a double-click from falling through to a new confirmation, exact menu targeting, Unicode cursor placement and keeping long drafts within the editor viewport. No external provider approvals, payment transactions or real email delivery were performed. These checks send real terminal input; they do not cover physical mice in every terminal emulator.

## Mouse support follow-up

The board now supports click selection, double-click conversation opening and wheel navigation in Kanban and list views. Twenty-one checks sent SGR mouse reports to the real CLI in a pseudo-terminal against the isolated HTTP server and Postgres database. They covered card and empty-column clicks, stable click targets, double-click opening, vertical and horizontal wheel input, batches of wheel events, right-click and outside-board handling, list view, resize hit testing at 60 and 40 columns, editor and confirmation isolation, and normal exit cleanup.

Additional lifecycle checks verified Ctrl+C and SIGTERM cleanup and screen-reader mode. The CLI restores mouse reporting and the original screen on exit. Screen-reader mode enables neither mouse reporting nor the alternate screen. The input tests cover report parsing, invalid input, double-click timing and identity, stable column positions and late reports reaching editors or menus. The TUI suite has 49 passing tests and one opt-in browser test skipped.

The mouse checks exercise the running application and actual terminal escape sequences. They do not constitute physical mouse testing in every terminal emulator.

## Kanban default follow-up

Kanban is now the default board. A further 16 real-terminal checks used 33 cards distributed across Backlog, six pipeline stages and Completed, including an empty Design stage. These verified the initial layout, stage counts, empty-column action safety, Tab navigation, vertical scrolling, first/last card navigation, list toggling, search into Completed, conversation entry and return, advancing a selected card, live server moves, activity targeting, command-palette toggling, empty-project switching and clean exit.

Resize checks at 40×12, 60×16, 80×24, 180×38 and 240×40 retained the heading and selected card. The 240-column terminal displayed all eight columns. Smaller terminals scrolled horizontally with the focused stage. Six additional regression tests cover grouping, navigation boundaries, empty-column targeting, selection after stage changes, viewport bounds and rendering within the available height. The TUI suite now has 43 passing tests and one opt-in browser test skipped; repository typecheck passed all 22 tasks.

These checks used an isolated HTTP server and temporary Postgres database. No real agent runs or external integrations were needed for this layout change.

The built CLI was launched in real pseudo-terminals and driven with keyboard input. This pass completed 53 scripted workflow checks against the real HTTP application and Postgres, plus a separate real Cursor agent lifecycle against the local Docker-backed server. Terminal output was decoded to check the visible screen, and mutations were read back through the API. The isolated multi-mode server used real bearer sessions and a recording mailer that did not deliver email.

## Keyboard coverage

| Area | Checks | Exercised behavior |
| --- | ---: | --- |
| Board | 14 | Command search, empty results, help paging, card creation and validation, multiline Unicode paste, advancing, completing, reopening, activity, deletion cancellation and confirmation, project switching, spend, sessions and four terminal sizes |
| Artifacts | 9 | Real PNG, HTML and Mermaid terminal rendering; zoom, pan and fit; invalid-image recovery; long source reading and search; authenticated file export |
| Team and account | 10 | Last-owner protection, invitation confirmation and cancellation, member roles, unsupported network policy, absent hosted billing, profile rename, ownership check before account deletion, organization creation, switching and exact-name deletion |
| MCP | 6 | Custom server creation, transport change, OAuth selection, client configuration with masked secret, disabling and removal |
| Setup | 8 | Agent creation, guided model/name editing, stage rename, assignment, gate configuration, YAML export, multiline operating instructions, agent removal and released stage assignment |
| Permissions | 2 | Member view hides administration actions; sign-out revokes the session and clears team data |
| Recovery | 4 | Unavailable server error, reconnect using retry, clean exit, retained multiline draft after an injected HTTP 503 followed by successful keyboard retry |

Resize checks used 80×24, 60×16, 40×12 and 140×40 terminals. Each checked that the project heading, board heading and selected card stayed visible while scrolling. For example, the 40-column screen showed:

```text
 Bento PTY Lab
 http://localhost:4499 · agents on ser…

 BOARD · 33 cards · 0 agents active
   ● PTY Scroll card 01  · Backlog · b…
 › ● PTY Scroll card 02  · Backlog · b…
 3 to 4 of 33 · ↑/↓ to scroll

 Enter read · : commands · q quit
 / search · p projects · , setup
```

## Real agent lifecycle

A temporary project used Cursor with `grok-4.6`. Runs were instructed to reply without tools or file changes, with automatic PR creation disabled. Starting through the TUI produced `BENTO_PTY_RUN_OK`; messaging the completed agent produced `BENTO_PTY_FOLLOWUP_OK`. Both responses appeared in the full conversation. A further run was stopped using `x`, and the board displayed the stopped state.

API read-back showed three succeeded runs and one cancelled run. The changes response contained no changed repositories. The rebuilt board was also checked during the final active run: its row and detail pane both displayed `running`, without the misleading approval-wait or missing-agent hint.

## Fixes found through testing

- Creating an agent in multi mode omitted its organization ID and failed under row-level security. Creation now records the active organization and rejects removed memberships. A real Postgres regression verifies both organizations and removal.
- Compact terminals could lose the board title and selection above the viewport. Compact layout reserves space for the board and short navigation hints.
- Searching for `OAuth` could choose `No authentication`. Exact and prefix menu matches now rank first, with Enter using the displayed order.
- Moving between wizard fields retained the previous field's cursor position. Clearing a name could leave trailing characters. Replacing the controlled field now places the cursor at its end.
- An active run's detail pane could show its underlying gated state and approval-wait text. It now reflects the active run and suppresses irrelevant setup hints.
- Startup could briefly display an empty board before the initial refresh. Connection now loads board data before opening it.

## Automated checks

- Repository typecheck: 22 tasks passed.
- TUI tests: 37 passed; the opt-in browser test was skipped in the default command and passed separately.
- Real Chromium preview suite: 3 passed, including script and external-request isolation.
- API client tests: 11 passed.
- Server tests against Postgres: tenant entity-route matrix and organization-scoped agent-creation regression both passed.

The failed-save regression now waits for the rendered error screen before retrying. The same behavior was verified separately through a real TUI and HTTP proxy that returned one temporary save failure.

The temporary live-run project and profile were deleted and their absence verified. The isolated test server and PTY processes were stopped, and their temporary database was removed. The existing local server and user projects were left running.

## Limits

This verifies the workflows above, not every external integration. Payment-provider transactions, OAuth approvals, email delivery, GitHub publishing, Linear/Slack writes and every agent adapter were not exercised end to end. Hosted billing was unavailable on the test deployment; its absent-service behavior and fixture-based tests passed. The history and artifact fixtures on the isolated server were synthetic; the Cursor run and follow-up used the real agent.

### Chat copying and Docker execution cleanup

Use **Copy chat**, or press `y` while reading history. Verify the latest agent reply,
a searched individual message, and the whole conversation retain their original
newlines and code blocks. Copying must preserve an unsent draft. Check both mouse
and keyboard selection, including a narrow terminal.

The Docker lifecycle regression test uses a disposable container with network access
disabled. It needs the local `bento-sandbox:dev` image and no agent credentials:

```sh
cd packages/sandbox
BENTO_DOCKER_E2E=1 node --test --import tsx src/docker-exec.e2e.test.ts
```

It verifies timeout, cancellation, early stream closure, stdin, and process isolation.
Cursor additionally uses `--background-shell-timeout 30`, so its completed turn can
finish even when a background development server stays open. An authenticated manual
check should start a long background shell task through Cursor and confirm Bento
receives a successful result after the final background wait ends.
