# Code review: Show card description

Reviewed `17ba335` (`Show a card's description in the drawer`) against the product investigation, engineering requirements, and the four review gates: requirements fit, modularity, bugs, and tests.

bento-cloud was not changed and did not need to be. The description already travels on every `Feature` the console holds.

## Requirements checklist

| Requirement | Verdict |
|---|---|
| Description visible in the web drawer after create | Met. `FeatureDrawer` reads `feature.description` from the board row. |
| Section only when `trim()` is non-empty; no empty box, no "add a description" | Met. `hasDescription` plus a conditional `<section>`. |
| Placement: between header and Actions, sibling `section`/`label` markup | Met. |
| Source is the `feature` prop, not the detail fetch; still shown when `loadFailed` | Met. Rendered before any fetched section. |
| Word for word, line breaks preserved, plain text, React-escaped | Met. `{description}` children, `white-space: pre-wrap`. Outer whitespace is trimmed (`descriptionText`); internal breaks stay. |
| Long text clamped at 12 lines / 900 characters with Show more / Show less | Met. `needsClamp` + `.card-description.clamped`. |
| Per-card reset of the expanded state | Met. Reset in the existing `feature.id` effect. Drawer also unmounts on close. |
| Board unchanged (Approach A, not B) | Met. `Board.tsx` still uses description only in `matchesQuery`. |
| No edit, no PATCH, no markdown, no linkification, no flag, no Mac/TUI, no bento-cloud | Met. |
| Unit tests of the presence and clamp rules | Met. Ten cases in `card-description.test.ts`. |

## Strengths

- The work is one render path. No schema, API, or client-type change, which matches the investigation: the field was already on the board payload.
- Presence and clamp live in `card-description.ts` as pure functions. That is the right seam: FeatureDrawer cannot be imported under `node --test` (its graph pulls `auth-client.ts`, which reads `window.location`), so testing the decisions without mounting the drawer is how this repo tests similar UI.
- The drawer wiring follows existing patterns: `section`/`label`, `btn btn-ghost`, History-style toggle, `aria-expanded` / `aria-controls` (stricter than History).
- Security is the one the requirements asked for. No `dangerouslySetInnerHTML`, no markdown, no auto-links. Linear and Slack bodies stay text.
- CSS `overflow-wrap: anywhere` is the right rule for the Slack permalink and Linear URL, which are one unbroken token.
- 900 characters is not a magic number in isolation. At the drawer content width (~504px at 13px) that is about twelve wrapped lines of prose, so the JS threshold and the CSS line-clamp are aimed at the same height.

## Issues

### Critical

None.

### Important

None. The feature as specified is present, scoped, and tested at the seam the requirements named.

### Minor

1. **FeatureDrawer itself is not rendered in unit tests**
   - File: `apps/web/src/components/FeatureDrawer.tsx` (import graph via `PromptDialog` → `GitHubIdentity` → `auth-client.ts:5`)
   - Placement, the `clamped` class, button copy, and the `loadFailed` path are covered by the implementer's headless Chromium pass, not by `node --test`.
   - Why it stays minor: that import graph is pre-existing; stubbing `window` to mount the drawer would be a new test harness, not a missing assertion. The extracted functions are the testable surface the requirements asked for.
   - How to improve later: a `window` stub at test entry, or a tiny presentational `CardDescription` component that FeatureDrawer renders and the tests import.

2. **No console e2e harness, so no automated e2e**
   - The repo's e2e tests are server-side. There is no Playwright (or similar) suite for the drawer.
   - Not applicable as a merge blocker. The implementation notes document a 20-assertion Chromium pass on a running console (short, empty, Linear-sized, search, board height, clamp reset).

3. **JS clamp and CSS clamp can disagree on a rare shape**
   - File: `apps/web/src/card-description.ts:49-52` vs `apps/web/src/styles.css` (`.card-description.clamped`)
   - `needsClamp` counts characters and `\n`; CSS counts painted lines. A ~901-character paragraph that wraps to eleven lines on a wide drawer would show Show more over text that was never cut. The requirements accepted this; 900 was picked to match ~12 lines at 560px. Do not "fix" it without measuring real drawer widths.

4. **CSS comment named the wrong file** (fixed in this review)
   - The clamp comment pointed at `FeatureDrawer.tsx`. `needsClamp` lives in `card-description.ts`.

## What this review added

- `board-card.test.ts`: a card whose description contains a unique phrase still renders only its title on the board. That pins Approach A so a later change cannot put the brief back on the card face without a failing test.
- The CSS comment correction above.

`node --test --import tsx "src/**/*.test.ts"` in `@bento/web`: **111 passed, 0 failed**, including the ten description cases and the new board case.

## Recommendations

- Leave clickable Linear/Slack URLs and markdown for a follow-up, as the investigation and requirements already routed those to design.
- If the next drawer feature also cannot be imported under `node --test`, extract the same way rather than growing a FeatureDrawer render harness for one section.

## Assessment

**Ready to merge?** Yes

The change does the one thing the product asked for: after create, a person who opens the card can read the same description the agent received, and only when one exists. The board stays a scan of titles. The code is a small, reusable pair of decisions plus one section. No new bugs showed up in review or in the 111 web unit tests. E2e is not applicable in this repo; the implementer's console pass plus the unit tests are the coverage this codebase uses for drawer UI.
