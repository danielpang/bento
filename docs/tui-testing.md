# TUI verification, 2026-09-06

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
