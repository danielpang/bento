# Show card description: engineering requirements

Engineering design for the product investigation's Approach A: after a card exists, the web card drawer shows its stored description, and only when one exists. This document was written after verifying every claim below against the code on this branch.

## Verdict on scope: one component, no new data path

The description already travels the whole way to the drawer. Nothing on the server, the schema, or the API client changes.

Verified facts the design rests on:

- `features.description` is stored at create (`apps/server/src/routes/features.ts`, create route, default `""`) and there is no PATCH for it, so the value is write once and can never be stale on the client.
- Both `GET /api/projects/:id/features` (board list) and `GET /api/features/:id` select full rows, so `description` is already in every `Feature` the console holds. The client type already declares it (`packages/api-client/src/types.ts`, `Feature.description: string`).
- The board already uses it: `matchesQuery` in `apps/web/src/components/Board.tsx` searches `feature.description`. The drawer receives that same `Feature` object as its `feature` prop.
- Content shapes that will actually arrive: dialog text (free prose, possibly multi line), Linear imports (`issue body + "\n\n" + issue URL`, composed in `apps/server/src/linear.ts:164`), and Slack cards (`Created from Slack: <permalink>`, `apps/server/src/orchestrator/slack-sync.ts:723`). Multi line text and long unbroken URLs are therefore normal inputs, not edge cases.

Deliverable: a Description section in `apps/web/src/components/FeatureDrawer.tsx`, a few rules in `apps/web/src/styles.css`, and unit tests. No changes in `bento-cloud` (billing), the server, the Mac app, or the TUI.

## Functional requirements

1. **Placement.** A `Description` section renders in the drawer body between the header (title, stage, status, branch) and the Actions section, using the existing `section` and `label` markup so it reads as a sibling of Requirements, History, and Changes.
2. **Presence rule.** The section renders only when `feature.description.trim()` is non empty. A card without a description gets no section, no empty box, and no "add a description" affordance. Whitespace only counts as empty.
3. **Source.** Render from the `feature` prop directly. Do not gate on the drawer's detail fetch: the text must appear instantly, needs no skeleton, and must still show when `loadFailed` is true (the description is board data, and the load failure notice is about the fetched detail).
4. **Fidelity.** The stored text shows word for word, with line breaks preserved. Linear imported cards show the stored issue body and URL; Slack cards show the stored permalink line.
5. **Long text.** Descriptions longer than the collapse threshold render clamped with a "Show more" / "Show less" toggle, following the History section's existing toggle pattern. Threshold: clamp when the text exceeds 12 lines or 900 characters, whichever trips first. Short descriptions get no toggle. This keeps a Linear issue body from pushing Actions off screen while keeping the common case (a few sentences) untruncated.
6. **Board unchanged.** No description text, marker, or extra height on the board card. Approach B was explicitly not chosen.

## Rendering and security rules

- **Plain text only.** Render into a normal element with `white-space: pre-wrap` and `overflow-wrap: anywhere` (Linear and Slack URLs are long unbroken tokens that must not blow out the drawer width). React's default escaping is the whole sanitization story; there is no `dangerouslySetInnerHTML` anywhere in this feature.
- **No markdown in v1.** Linear bodies can be markdown, but rendering it means either loading the lazy `ArtifactViewer` bundle for every drawer open or adding react-markdown to the main bundle, and it widens the injected content surface for text that agents and integrations write. Plain text is the floor the investigation accepted. If the design stage wants markdown, it must reuse the existing react-markdown configuration with raw HTML off (see the artifact rules in CLAUDE.md) and nothing looser.
- **No auto linkification in v1.** The Slack permalink and Linear URL show as text. Making them clickable is a candidate follow up for the design stage; it is not required for the acceptance criteria and adds URL parsing that plain text does not need.
- **Copy.** Section label is `Description`. No other new user facing strings, so no em or en dash exposure beyond the repo rule already covering the file.

## Feature flag

Ship without the `beta-testers` flag. The flag convention covers unfinished UI and endpoints not ready for every user. This change is complete in one PR, adds no endpoint, and reveals only data the same user already receives in every board payload and already matches in search. The investigation classifies the current state as a defect; defect fixes do not go behind the flag.

## Implementation sketch

In `FeatureDrawer.tsx`:

```tsx
{hasDescription(feature.description) && (
  <section className="section">
    <span className="label">Description</span>
    <p className={clamped ? "card-description clamped" : "card-description"}>
      {feature.description}
    </p>
    {needsClamp(feature.description) && (
      <button className="btn btn-ghost" onClick={toggle}>
        {expanded ? "Show less" : "Show more"}
      </button>
    )}
  </section>
)}
```

Extract the two decisions as pure exported functions (for example `hasDescription(text)` and `needsClamp(text)`) so they are testable in the repo's node:test style without rendering. Reset the expanded state when `feature.id` changes, alongside the existing per card resets in the first `useEffect`. CSS: `card-description` gets `white-space: pre-wrap; overflow-wrap: anywhere;` and the clamp uses `-webkit-line-clamp` with the line threshold; the character threshold in `needsClamp` is what decides whether the toggle exists, so the two must agree closely enough that the toggle never appears under unclamped text.

## Test plan

Unit (node:test, matching `search.test.ts` style, new file such as `apps/web/src/card-description.test.ts`):

- Empty string and whitespace only mean no section.
- Any non whitespace text means a section.
- `needsClamp` boundaries: just under and just over both thresholds, and multi line versus single line inputs.

Manual, per the "verify against something real" rule, on the running console (`pnpm dev`, console on 4401):

1. Create a card with a title and a multi line description. Open it: the text is in the drawer word for word, above Actions, line breaks intact.
2. Create a card with only a title. Open it: no Description section, and the drawer looks intact, not unfinished.
3. Paste a Linear sized body (over 900 characters) into a new card. Open it: clamped, Show more expands it, closing and reopening the drawer resets to clamped.
4. Search for a phrase that exists only in a description. The card matches and opening it shows the phrase.
5. Confirm the board lanes did not change height and a card row shows no description text.

Steps 1 and 2 are the investigation's acceptance criteria one and two; a Linear or Slack created card is exercised by step 3's shape (long body plus a bare URL) when a live integration is not connected in the dev environment.

## Out of scope, restated for the implementer

No edit control and no PATCH route. No board card changes. No Mac or TUI work (their protocols do not carry the field today). No markdown rendering, no linkification, no analytics. Nothing in `bento-cloud`.

## Open questions routed to the design stage

- Should the Slack permalink and Linear URL be clickable links? (Engineering position: fine as a follow up, keep v1 plain.)
- Exact clamp threshold and type treatment of the description block (the 12 line / 900 character numbers here are a working default, not a design decision).
