# Implementation: Indicate issues already in Bento

**Feature:** Indicate issues are already in Bento in the "Import issues" section
**Linear:** [DPA-6](https://linear.app/dpang-studios/issue/DPA-6/indicate-issues-are-already-in-bento-in-the-import-issues-section)
**Stage:** Implementation

## What shipped

Settings → Linear → Import issues now says why a row cannot be checked.
An issue that already has a `linear_issue_links` row carries a muted
chip reading **Already in Bento**, and the row's hover text reads "This
issue is already a card in Bento, so it cannot be imported again." The
plain `(imported)` text is gone.

Behaviour is unchanged: the checkbox is still disabled for a linked
issue, the server still dedupes, and rows Bento does not have look and
behave exactly as before.

## Changes

| File | Change |
| --- | --- |
| `apps/web/src/components/LinearPanel.tsx` | Row extracted as `ImportIssueRow`, which renders the chip and the hover text for `issue.imported`. |
| `apps/web/src/styles.css` | `.gate-check .chip { flex: none }`, so a long issue title wraps rather than squeezing the chip. |
| `apps/web/src/import-issue-row.test.ts` | New: covers the chip, the hover text, the disabled state, the absence of any cue on a fresh row, and a busy row not claiming Bento has the issue. |

Notes on the choices:

- The chip is `chip chip-soft`, the existing "states a fact rather than a
  status" chip (`RepositoriesPanel` uses it for `main`). No new colour,
  so nothing reads as a pipeline status.
- The chip lives inside the `<label>`, so it is part of the checkbox's
  accessible name rather than decoration a screen reader skips.
- `title` sits on the row, matching the existing pattern of a `title`
  explaining a disabled control (`RepositoriesPanel`'s Remove button).
  Browsers do not always surface an ancestor's tooltip while the pointer
  is over a disabled input itself, which is one reason the cue is not
  hover-only.
- Copy says Bento has the issue, not that this project does: the link is
  unique per organization, so the card may live in another project.

## Deviations from the plan

The design and engineering-requirements stages left no documents
(`docs/bento/design.md` and `docs/bento/engineering-requirements.md` do
not exist), and the investigation's two open decisions were never
answered on the card. This took the investigation's recommendations:
option **C** (chip plus hover) with copy **1** ("Already in Bento"). If
the reviewers wanted hover only, or "In Bento", the change is one line
each.

`ImportIssueRow` is exported so a test can render it. `ImportCard` holds
the list state, and a server-rendered `ImportCard` has no rows yet, so
the row is the smallest thing that can be asserted on.

## Verification

- `pnpm test`: `@bento/web` 24 pass, 0 fail (5 new). `@bento/api-client`,
  `@bento/core`, `@bento/gates`, `@bento/tui`, `mac` all pass.
- `pnpm typecheck`: 20 tasks, all pass.
- `@bento/server` tests fail in this environment, all 247 of them on
  `ECONNREFUSED` to `localhost:5439`: the sprite has neither Docker nor a
  Postgres, so the suite cannot reach a database. Nothing here touches
  the server.
- No browser in this environment either, so the visual check is a
  self-contained page rendered from the real component and the real
  stylesheet: `import-already-in-bento.html` in the feature's artifacts
  (not committed). The list still wants one look in a real browser
  against a live Linear connection, which is the manual check the
  investigation described.
