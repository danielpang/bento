# Show card description: implementation

Approach A from the investigation, built as the engineering requirements
specified: the web card drawer shows the stored description, and only
when there is one. One repository, one component, no new data path.

## What changed

| File | Change |
|---|---|
| `apps/web/src/card-description.ts` | New. `hasDescription`, `descriptionText`, `needsClamp`: the two decisions the section makes, as pure functions |
| `apps/web/src/components/FeatureDrawer.tsx` | New Description section between the header and Actions, with the Show more toggle and its per card state |
| `apps/web/src/styles.css` | `.card-description` and its clamped variant, and a corrected comment on which drawer panel is the topmost one |
| `apps/web/src/card-description.test.ts` | New. Ten node:test cases over the presence and clamp rules |
| `docs/web-app.md` | The drawer's one line description in the file table now names the brief |

Nothing in `bento-cloud`, the server, the schema, the API client, the
Mac app, or the TUI. The description was already on every `Feature` the
console holds, from both the board list and the card detail, so this is
a render, not a fetch.

## How it behaves

- **Placement.** A `section` with the label `Description`, above Actions,
  in the same panel markup as Requirements, History, and Changes.
- **Presence.** Rendered only when the stored text has something other
  than whitespace in it. A title-only card grows no panel, no empty box,
  and no invitation to add one.
- **Source.** Read off the `feature` prop, not the drawer's detail fetch,
  so it is on screen the moment the drawer opens, needs no skeleton, and
  is still readable when the detail load failed.
- **Fidelity.** Plain text, escaped by React, `white-space: pre-wrap` so
  paragraphs survive and `overflow-wrap: anywhere` so a Linear or Slack
  URL, which is one unbroken token, cannot widen the drawer.
- **Long text.** Over 900 characters or over 12 lines opens clamped at
  12 lines behind Show more / Show less. The state resets per card,
  alongside the drawer's other per card resets, so opening the next card
  does not find it already unrolled.
- **The board is untouched.** No description text, no marker, no extra
  height. Search still matches the description, and now a card found
  that way can explain itself.

The clamp threshold lives in two places by necessity: `needsClamp`
counts characters and newlines, the CSS counts the lines the browser
drew. They are commented as a pair, because a toggle over text that was
never cut does nothing when pressed.

## What was verified

Node was not installed in this environment, so one was fetched, along
with Postgres and a headless browser, to run the checks:

- `pnpm --filter @bento/web test`: 110 tests pass, including the ten new
  ones (empty and whitespace only, missing values, word for word text
  with its line breaks, both clamp boundaries just under and just over,
  and a Linear sized body).
- `pnpm --filter @bento/web typecheck`: clean.
- `pnpm --filter @bento/web build`: clean.
- The running console, which is the check that counts. Postgres 16 on
  5439, migrations applied, the server in local mode on 4400 and Vite on
  4401, three cards created through `POST /api/features` (a short
  description, a Linear sized one with a bare issue URL, and one with no
  description at all), and the board driven in headless Chromium. Twenty
  assertions, all passing:
  - the board carries no description text, and its lanes are unchanged;
  - the Description panel renders, above Actions, and the text comes
    back word for word with its blank line intact;
  - a title-only card has no panel, and its drawer starts at Actions;
  - the long one is clamped, and the clamp really cuts (234px shown of
    390px), so the buttons stay on screen;
  - Show more expands it, says `aria-expanded`, and flips to Show less;
  - the issue URL shows as text and does not widen the drawer
    (`scrollWidth <= clientWidth`);
  - closing the card and reopening it clamps again;
  - searching a phrase that exists only in a description ("Eircode")
    finds the card, and opening it shows the phrase.

The whole repository suite (`pnpm test` against that database, on Node
22.22 so the `mac` package runs) is 22 of 23 tasks green. The one
failure is `packages/sandbox`, whose toolchain test asserts the x64 Node
tarball URL while this machine is arm64. It predates this branch and has
nothing to do with the console.

Not exercised: a real Linear import or Slack card, because neither
integration is connected here. Both store their text in the same column,
and the long card's shape (an issue body plus a bare URL) is what they
produce, which is the substitution the requirements allowed.

## Artifact

`/workspace/artifacts/card-description-drawer.html`: screenshots of the
running console, one per state, with the board for the "nothing moved"
comparison.

## Deliberately not built

No edit control and no PATCH route, no board card change, no markdown,
no linkification of the Slack permalink or Linear URL, no Mac or TUI
work, no analytics, and no `beta-testers` flag: this is a defect fix
that reveals data the same user already receives in every board payload.
The two open questions the requirements routed to design (clickable
links, and the exact clamp numbers) are unchanged and still open; the
12 line and 900 character defaults are what shipped.
