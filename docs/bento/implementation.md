# Implementation: move feature cards to the done column

## What shipped

A card can now be marked done from wherever it is, skipping the stages
it has not been through. Two doors, one move:

- **The board's Done lane takes drops.** Drag a card there from any
  stage lane, or from the backlog, and it is finished from the lane it
  left. The lane lifts while a card is over it, the same cue every other
  lane gives.
- **`Mark done` in the card's drawer.** The same move without a mouse,
  beside the stage actions. Offered on a card in a stage and on one
  still in the backlog, and not on a finished one, which offers `Reopen`.

Nothing else about "done" changed: the card keeps the stage it was in,
so `Reopen` puts it back there, no agent runs on it, and its sandbox is
reaped because the card is over.

## Server

`POST /api/features/:id/finish` (`apps/server/src/routes/features.ts`),
backed by `finishFeature` in
`apps/server/src/orchestrator/gate-evaluator.ts`.

Its own route rather than a target of `/move`, because done is a status
and not a stage: `/move`'s body names a stage id (or null for the
backlog) and there is no id to name here. `finishFeature` does what
`advanceFeature` does when a card clears the last stage, so there is one
kind of done and not two: the status update is guarded on the stage the
card is in and on it not already being done, both history rows are
written (the `feature_events` check constraint wants a `stage_moved` and
a `status_changed`), the sandbox reap is queued, and the board event is
emitted. It consults no gate and starts nothing: the person is the gate,
the way `/advance` already treats them. No entitlement check, because a
card going to done stops being live and the plan counts live cards.

Two things had to give way for it:

- **Reopening no longer requires a stage.** A card finished straight
  from the backlog has none, and `reopenFeature` used to refuse without
  one, which would have made that card the frozen thing reopening
  exists to prevent. It now reopens into the backlog, and `/back` asks
  the done question before its "already in the backlog" refusal.
- **A gate evaluation can no longer un-finish a card.** `holdFeature`
  wrote `status = 'gated'` by feature id alone, so an evaluation queued
  by the move that put the card in the stage could land after the finish
  and drag the card back, held by a stage it had already left. The write
  is now guarded on the status the evaluation started from, and nothing
  is written when the guard misses.

## Clients

- `packages/api-client`: `finishFeature(featureId)`.
- `apps/web/src/components/Board.tsx`: the Done lane gets drop handlers
  through a new `onFinish` prop. `laneDropProps` now takes what a drop
  should do rather than a stage id, because the Done lane is not a
  stage. The card-travel key includes whether a card is finished, since
  finishing moves a card between lanes without changing its stage.
- `apps/web/src/App.tsx`: the optimistic update sets `status: "done"`
  and leaves the stage alone, which is what the server does.
- `apps/web/src/components/FeatureDrawer.tsx`: the `Mark done` button,
  and the finished card's note no longer claims the card went through
  every stage.

## Copy that became untrue

Three strings said "this card finished the pipeline" in one form or
another, which is now false for some done cards:

- The Linear comment ("Bento finished this card. Every stage is
  complete." to "Bento finished this card.").
- The mac app's gate note.
- The history line for a `stage_moved` with no destination, which read
  "finished <stage>". Off the last stage it still does; off an earlier
  one it reads "done from <stage>", in the web drawer, the TUI, and
  `/history/plain`.

## Tests

`pnpm test` (21/21 tasks, 175 server tests) with Postgres on 5439.

- `e2e.test.ts`: a new test marks a card done from the second of six
  stages and checks the kept stage, both history rows, the plain history
  wording, that no agent may start on it, that finishing twice is
  refused, and that reopening returns it to that stage rather than the
  last one. It then finishes a card straight from the backlog and
  reopens it there.
- `e2e.test.ts`: the existing done-card test now also asserts `/finish`
  and `/move` refuse a done card, and that clearing the last stage still
  reads as finishing it.
- `auth.e2e.test.ts`: `/finish` added to the foreign-tenant matrix.

## Verified in a browser

Chromium against a local-mode server serving the built console: dragging
a card from a stage lane onto Done (the lane lifts, the card lands and
reads "done  reopen to move"), dragging a backlog card onto Done,
`Mark done` from the drawer on both a staged and a backlog card, and
`Reopen` putting the card back in the stage it was finished from.
Screenshots are on the card.

## Notes for whoever picks this up next

- No prior stage documents existed
  (`docs/bento/product-investigation.md`, `design.md`,
  `engineering-requirements.md` were all absent), so the shape above is
  mine, from the feature description.
- The TUI and the mac app got the corrected history wording but no
  finish action of their own; adding one is a small route call in each
  and was left out as beyond "the done column".
- Marking a card done while an agent is still working it is allowed, as
  it already is through the last stage's approval: the run finishes on
  its own, its gate evaluation returns early because the card is done,
  and the reap job retries until the run stops. Refusing it, or
  cancelling the run, would be a decision about running agents rather
  than about this lane.
