# Delete card: engineering requirements

Working from `docs/bento/product-investigation.md` and
`docs/bento/design.md`. The contract both handed forward: **delete the
row and destroy the sandbox, never the branch and never the pull
request, refuse while an agent is running, and emit a board event so
the card leaves everybody's screen.**

This document is the build plan. Every claim below was checked against
the code at the commit this branch starts from, with file and line
references, and the decisions the investigation left open are taken as
the design took them: hard delete with spend going (no `deleted_at`),
409 under a live run, any member may delete, and archiving (Need B) is
a separate card.

## The change at a glance

| Where | What changes |
|---|---|
| `apps/server/src/routes/features.ts` | New `DELETE /:id` route |
| `apps/server/src/events.ts` | `feature_deleted` joins `BoardEvent` |
| `apps/server/src/orchestrator/start-run.ts` | `startRunIfIdle` learns to answer "gone" |
| `packages/sandbox/src/sprite.ts` | `destroy` stops swallowing every error |
| `packages/api-client/src/client.ts` | `deleteFeature(id)` |
| `apps/web` | Drawer button and dialog, board event handling, empty CTA, session page 404 state, focus rule |
| `apps/tui/src/app.tsx` | Selection survives the selected card vanishing |
| `apps/server/src/auth.e2e.test.ts` | Matrix row for the new route |
| `apps/server/src/e2e.test.ts` | Delete behaviour tests |

**No database migration.** Every foreign key this needs already exists,
and the one that looks wrong (`sandboxes.feature_id` is
`on delete set null`, `packages/db/src/schema/app.ts:342`) is kept that
way on purpose; see "Data" below. RLS needs nothing: each table carries
one `ALL` policy comparing `organization_id` to the request's org
(`packages/db/migrations/0000_bento.sql:466`), which covers DELETE, and
`bento_user` already holds the DELETE grant (`0000_bento.sql:475`).
Cascades fire as referential actions, which Postgres exempts from row
security, so they cannot be blocked by a policy mid-delete.

## The API

`DELETE /api/features/:id`

| Status | Body | When |
|---|---|---|
| 200 | `{ "ok": true }` | Deleted |
| 404 | `{ "error": "not found" }` | Unknown id, foreign tenant, or a repeat of a delete that already landed |
| 409 | `{ "error": "An agent is working this card. Stop it first, then delete." }` | A run is queued, starting, or running |
| 502 | `{ "error": "the sandbox could not be destroyed (...). The card was not deleted; try again" }` | `driver.destroy` failed; nothing was changed |

The 409 gets its own constant next to `CARD_BUSY` in
`start-run.ts` (call it `CARD_BUSY_DELETE`). `CARD_BUSY` itself says
"wait for it to finish or cancel it first", which is advice about
starting a second run; waiting does not delete a card, so reusing it
would mislead (design, section 9).

404 for a repeat rather than success, copying the reasoning already
written down in the profiles delete
(`apps/server/src/routes/profiles.ts:240`): answering the same thing to
"deleted it already" and "that is not yours" is what keeps the route
from confirming which ids exist.

The design's fourth API requirement (the session page telling a deleted
card apart from a dead server) needs no server work: `GET
/api/features/:id` already answers 404 with a JSON error, and
`ApiError` in the client already carries `.status`
(`packages/api-client/src/client.ts:69`). The gap is purely that
`SessionPage.tsx` throws the status away.

## The server route, step by step

Added to `featureRoutes` in `features.ts`. The whole route runs on
`tenantDb`, so in multi mode RLS applies to every statement (layer 2
stays live under layer 1, per `CLAUDE.md`).

1. `getAccessibleFeature(ctx, c, id)`; null is 404. This is the route
   check the matrix test pins.
2. Open a transaction on `db(c, ctx)`. In multi mode the request is
   already inside the tenant transaction
   (`apps/server/src/middleware/tenant.ts:34`), so this nests as a
   savepoint; in local mode it is the transaction. `startRunIfIdle`
   does exactly this already (`start-run.ts:23`), so the pattern is
   established.
3. `select id from features where id = $1 for update`. This is the same
   row lock `startRunIfIdle` takes first (`start-run.ts:24`), which is
   the whole concurrency story: a delete and a run start on the same
   card serialize on this lock, whoever wins. Zero rows back means the
   card went between steps 1 and 2: answer 404.
4. Check for an active run, same predicate as `startRunIfIdle`
   (`agent_runs.status in ACTIVE_RUN_STATUSES`,
   `start-run.ts:8`). Found one: answer 409 with `CARD_BUSY_DELETE`.
   "Queued" counts as active, which has a useful side effect: no
   `run.execute` job in pg-boss can ever name a run this delete removes,
   because the delete refuses while such a run exists.
5. Read the card's sandbox rows: `sandboxes.feature_id = id and status
   != 'destroyed'`. For each, build the handle exactly as the publish
   route does (`features.ts:591`, including the `provider === "sprite"`
   branch) and `await ctx.driver.destroy(handle)`.

   **Destroy before the row delete, and fail the whole request if it
   throws.** The ordering is the point of the feature: a deleted row
   with a live machine is the unfindable, metered orphan the
   investigation opened with, while a destroyed machine with a
   surviving card is merely annoying (the card stays, the person
   retries, a future run would reprovision). On failure return 502 and
   let the transaction roll back; nothing observable changed.
6. Local mode cleanup: for each project repository,
   `ctx.worktrees.remove(repo.localPath, feature.id, repo.name)`
   (`packages/sandbox/src/worktree.ts:191`). Already best effort (it
   swallows "already gone"), and `git worktree remove` does not touch
   the branch, so the survival guarantee holds. Uncommitted work in the
   worktree goes, which is the same contract as the sandbox being
   thrown away: committed work survives on the branch, nothing else is
   promised.
7. Delete the sandbox rows read in step 5. Explicitly, not by cascade;
   see "Data".
8. Delete the `features` row. The cascades take `agent_runs`,
   `run_events` (through runs), `gate_checks`, `feature_events`, and
   `feature_pull_requests`; the FK table below is the checklist.
9. After the transaction body: emit
   `{ type: "feature_deleted", projectId, featureId }` on the bus and
   return `{ ok: true }`.

   One honest caveat: in multi mode the tenant transaction commits
   after the handler returns, so the emit precedes the commit by a
   moment. Every existing emitter in a route has the same window (the
   publish route emits at `features.ts:636`), and the web client
   coalesces refreshes by 250ms, which covers it in practice. If a
   ghost card is ever observed, the fix is to run steps 2 to 8 on
   `ctx.db` in a self-committed transaction; not doing that now keeps
   RLS on the delete statement.

Nothing needs cleaning in `ctx.running` or `ctx.liveInputs`
(`apps/server/src/context.ts:76`): both are keyed by active runs, and
step 4 guarantees there are none.

## Hardening `startRunIfIdle`: the other side of the race

Today `startRunIfIdle` locks the feature row without checking it got
one (`start-run.ts:24`). Once delete exists, this sequence becomes
reachable: a start blocks on the delete's lock, the delete commits, the
start proceeds against a vanished card, and the `agent_runs` insert
dies on its foreign key as an unhandled 500.

Change the locked select to notice zero rows and return `"gone"`
(alongside the existing `AgentRun | "busy"`). Callers, all of them:

- `routes/runs.ts:50` (create) and `:87` (resume): answer 404
  `not found`.
- `routes/features.ts:286` (message) and `:722` (quick-run): answer
  404 `not found`.
- `gate-evaluator.ts:332`, `:443`, `:834` (the auto-start paths): skip
  quietly, same as they treat `"busy"`.
- `run-executor.ts:726` (`deliverQueuedMessage`): skip quietly.

The compiler enforces the sweep: adding the variant to the return type
breaks every call site until it is handled.

Everything else in the run system already copes. `evaluateFeatureGate`
returns early when the feature is gone (`gate-evaluator.ts:22`), so
queued `gate.evaluate` jobs naming a deleted card no-op. The runner
report path answers 404 for a vanished run
(`routes/runner.ts:61`), which only matters in the sliver between a
cancel landing and the runner noticing.

## The board event

`BoardEvent.type` in `apps/server/src/events.ts:11` gains
`"feature_deleted"`. Payload is `projectId` and `featureId`; no status,
no stage, because there is no row left to describe. A removal cannot be
expressed as `feature_updated`: the web client's fallthrough for that
type is "refetch and re-render what exists", which is coincidentally
right, but the drawer-open case (design, section 6) needs to know the
card is gone, not changed.

Only the web console consumes the board stream. The TUI polls every 3
seconds (`apps/tui/src/app.tsx:329`) and the Mac app polls
`board/plain` on the same cadence (`apps/mac/src/core.ts:2716`), so
both converge within a poll with no protocol change.

## Data: what goes with the card, what stays

| Table | FK behaviour | Outcome |
|---|---|---|
| `agent_runs` | cascade (`app.ts:366`) | Gone, with recorded spend |
| `run_events` | cascade via runs (`app.ts:419`) | Transcripts gone |
| `gate_checks` | cascade (`app.ts:437`) | Gone |
| `feature_events` | cascade (`app.ts:297`) | History gone |
| `feature_pull_requests` | cascade (`app.ts:264`) | Bento stops tracking; the PR itself is untouched |
| `sandboxes` | **set null** (`app.ts:342`) | Rows deleted by the route itself, after destroy succeeds |
| The branch, in every source repository | not Bento's to delete | Survives; `collectFeatureChanges` reads from it, nothing here touches it |
| Open pull requests on GitHub | no close path exists in `packages/github` | Stay open, as the dialog promises |

`sandboxes.feature_id` stays `set null` deliberately. Changing it to
cascade would make the route's step 7 free, but it would also mean a
self-hoster's bare `delete from features where id = ...` in psql
silently erases the only pointer to a still-running, still-billed
machine. With `set null`, that out-of-band delete leaves a row with a
null `feature_id` as evidence something is adrift, which is exactly the
check the investigation proposed (`select count(*) from sandboxes where
feature_id is null`). The supported path deletes its rows only after
the machines are confirmed gone, so it leaves the count at zero.

Project spend drops by the deleted card's recorded cost, because spend
is a join through features (`routes/projects.ts:494`). Decision 1
accepts this; the confirm dialog names the figure before the click.

## Driver change: SpriteDriver.destroy must stop lying

`sprite.ts:359` is `await this.client.deleteSprite(...).catch(() => {})`.
Every failure is swallowed, including a Fly API error, so the route
would report a machine destroyed while it keeps billing. Change it to
tolerate only not-found and rethrow everything else, which is exactly
what the Docker driver already does (`docker.ts:232`, tolerates
statusCode 404). `destroy` has no callers in server code today, so the
behaviour change breaks nobody.

This route is the first production caller of `destroy` on any driver.
That is a named risk from the investigation: verify against a real
Docker daemon (delete a card that has run, then
`docker ps -a --filter label=dev.bento.feature=<id>` returns nothing)
and, for hosted, a real sprite, before calling this done. The
LocalProcessDriver's destroy (`local-process.ts:124`) is also in scope
for local mode and is trivial.

## Web console

**`packages/api-client/src/client.ts`**: add `deleteFeature(id)`
returning `{ ok: boolean }`, modelled on `deleteStage`
(`client.ts:440`). `ApiError` already carries status and unwraps the
error envelope, so callers can branch on 409 and 404.

**`FeatureDrawer.tsx`**: the Actions section (lines 220 to 379) gains a
hairline rule and a quiet danger button after the action grid, and the
`dialog` state union (line 60) gains `"delete"`. Disabled states:

- `runActive` (line 182) disables it with the same `title` sentence the
  Approve button uses (line 248), plus `aria-describedby` pointing at a
  visually hidden copy of the sentence, because a `title` on a disabled
  button reaches neither keyboard nor screen reader. Approve should get
  the same treatment while the pattern is being introduced, but that is
  a courtesy, not a requirement of this card.
- Detail failed to load (the drawer's existing error state) disables it
  with the design's "Reopen the card first" sentence, because the
  dialog cannot choose between its variants without the runs list.

The dialog is `ConfirmDialog` with `destructive`
(`PromptDialog.tsx:424`), which already disables its buttons in flight.
Body text is assembled from the design's clause rules; every input is
already in the drawer: `runs` (with `costUsd`), `feature.branchName`,
`pullRequests`, and the spend arithmetic `CardSpend` uses (lines 40 to
53), including its "no run reported a cost" caveat that drops the
dollar clause.

On confirm, `client.deleteFeature(feature.id)` directly rather than
through the drawer's `act` helper, because the outcomes differ by
status: 200 shows the "Deleted" toast (`useToast().note`), tells App to
clear the selection, and triggers `onChanged()`; an `ApiError` with 409
shows the design's run-active toast; 404 shows "That card was already
deleted." and still triggers `onChanged()` so the ghost leaves; other
errors go to `toast.fail(err)` as everywhere else. No optimistic
removal.

**`App.tsx`**: the board stream handler (lines 303 to 337) gets an
explicit `feature_deleted` arm: when `selectedId` matches the event's
`featureId`, clear the selection and toast "The card you had open was
deleted."; in every case fall through to the coalesced `refresh()`. The
deleting tab clears `selectedId` synchronously when its DELETE returns,
before its own copy of the SSE event can arrive, which is what keeps
this toast out of the tab that did the deleting.

**`Board.tsx`**: the backlog empty CTA (line 402) reads "Add your first
card" only when the whole board holds zero cards, "Add a card"
otherwise. One comparison against the `features` prop it already has.

**Focus**: new code, nothing exists to reuse. Before issuing the
delete, compute the id of the card after the doomed one in flattened
lane order (falling back to the one before, then to the lane CTA);
after the refresh lands, focus the matching `[data-feature]` element,
which `useCardTravel` already tags (`Board.tsx:24`). Without this,
`Modal`'s focus restore finds its opener unmounted and its
`isConnected` guard (`Modal.tsx:62`) drops focus to `body`.

**`SessionPage.tsx`**: the catch at lines 21 to 38 currently discards
the error. Branch on `err instanceof ApiError && err.status === 404`
into the design's "This card was deleted." state with the existing
back-to-board button; every other failure keeps the current "check the
server" sentence.

## TUI and Mac

Neither client gets a delete control (design decision, matched pairs
argument). Resilience differs:

**TUI, one real bug to fix.** Selection resolves by id each render with
`Math.max(0, findIndex(...))` (`apps/tui/src/app.tsx:355`), so a
deleted selected card silently teleports the highlight to the first
backlog card while `selectedFeatureId` keeps the dead id, and the
per-card fetches 404 into swallowed catches. Change the resolution:
when the id no longer resolves, select the nearest surviving card in
the same flattened order, write its id back to `selectedFeatureId`, and
`setNotice("That card was deleted.")` (the notice line and its 6 second
expiry exist, `app.tsx:233`).

**Mac, no change.** The board poll already re-finds the selection by id
and closes the detail pane when it is gone (`core.ts:1229`), and a
write racing the delete already answers "That is gone, or belongs to
another organization. Refresh and try again." (`core.ts:747`). That
meets the design's requirement as shipped behaviour; noting it here is
what makes the omission a decision.

## Tests

- **The matrix, non-negotiable per `CLAUDE.md`**: add
  `["DELETE", "/api/features/${feature.id}"]` to the attempts list in
  `auth.e2e.test.ts` (line 302), and add a post-check that the owner
  still sees the card afterwards, the same shape as the profiles
  post-check at line 378. The row proves the refusal; the post-check
  proves the refusal did not delete anyway.
- **`e2e.test.ts`**, against the real Postgres the suite already runs:
  - Delete a fresh card: 200, gone from the list, second DELETE 404.
  - Delete a card with finished runs: `run_events` for those runs are
    gone, `feature_events` gone, `sandboxes` holds no row with a null
    `feature_id`, and the fake driver (its `destroy` stub is at
    `e2e.test.ts:2075`) records a destroy call for the card's sandbox.
  - Delete during an active run: 409, body is exactly
    `CARD_BUSY_DELETE`, card and run untouched.
  - Destroy failure: a driver whose `destroy` throws gets a 502 and the
    card still exists with its sandbox row intact.
  - `startRunIfIdle` on a deleted feature returns `"gone"`, and the
    message and quick-run routes answer 404 for it.
- **By hand, because green tests have lied here before** (`CLAUDE.md`):
  the design's browser checklist (two tabs, drawer open in the second,
  session tab, focus landing, dialog wording on a card with runs but no
  reported cost), plus `docker ps -a --filter
  label=dev.bento.feature=<id>` empty after deleting a run card, plus
  the psql orphan counts, plus confirming the branch and any open PR
  survive in the source checkout.

## Risky parts and what cannot be undone

1. **The delete is irreversible by design.** No `deleted_at`, no trash.
   Transcripts, history, and recorded spend go, and the project total
   moves. The dialog says all of this before the click; nothing in the
   implementation softens it, deliberately.
2. **First production use of `driver.destroy`.** Mitigated by ordering
   (destroy first, delete only on success), by the sprite driver
   change, and by manual verification against real Docker. If destroy
   misbehaves, the failure mode is a 502 with the card intact, never a
   silent orphan.
3. **Destroy succeeded, commit failed.** The residual gap in the
   ordering: the machine is gone but the card survives with sandbox
   rows claiming otherwise. Rare (a commit failing after successful
   statements), recoverable (a later run fails visibly or
   reprovisions), and strictly better than the inverse. Accepted.
4. **Runner-executed cards.** The server cannot reach a sandbox on
   somebody's laptop. The delete still refuses while a runner run is
   active; after that, the row delete is clean but the container on the
   runner machine is left for the runner's own lifecycle. That machine
   is the user's, unmetered by Bento. Accepted and documented rather
   than solved.
5. **The pre-commit event window** described in step 9. Shared with
   every existing emitter, covered by the client's refresh coalescing,
   and with a named fallback if it ever bites.

## Out of scope, restated from the earlier stages

Archive or cancel (Need B, next card, owns the `cancelled` vocabulary),
title and description editing, deleting branches or closing pull
requests, undo, bulk delete, project delete, a general sandbox reaper,
and delete controls in the TUI or Mac app.
