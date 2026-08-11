# Delete card: implementation

Built from `docs/bento/engineering-requirements.md`. The contract the
earlier stages handed forward is the contract that shipped: **delete the
row and destroy the sandbox, never the branch and never the pull
request, refuse while an agent is running, and emit a board event so the
card leaves everybody's screen.**

The plan was followed except where the code disagreed with it. Two
places did, and both are written up under "Where the plan was wrong"
rather than quietly worked around.

## What was built

| Where | What |
|---|---|
| `apps/server/src/routes/features.ts` | `DELETE /:id`: access check, row lock, active-run refusal, sandbox destroy, cascade delete, board event |
| `apps/server/src/events.ts` | `feature_deleted` joins `BoardEvent` |
| `apps/server/src/orchestrator/start-run.ts` | `CARD_BUSY_DELETE`, and `startRunIfIdle` answers `"gone"` |
| `apps/server/src/routes/runs.ts`, `features.ts`, `gate-evaluator.ts`, `run-executor.ts` | Every `startRunIfIdle` caller handles `"gone"`: 404 at a door, quiet skip on an auto-start |
| `packages/sandbox/src/sprite.ts` | `destroy` tolerates only "already gone" and rethrows the rest |
| `packages/api-client/src/client.ts` | `deleteFeature(id)` |
| `apps/web/src/components/FeatureDrawer.tsx` | Delete button under a rule, its disabled reasons, the confirm dialog and its clause rules |
| `apps/web/src/App.tsx` | `feature_deleted` handling, the "you had it open" toast, focus placement |
| `apps/web/src/components/Board.tsx` | `neighbourCardId`, and the backlog CTA that stops saying "first" |
| `apps/web/src/components/SessionPage.tsx` | A 404 reads as "This card was deleted." |
| `apps/tui/src/app.tsx` | Selection survives the selected card vanishing |

No migration, as the plan predicted: every foreign key this needs
already existed.

### The API, as shipped

`DELETE /api/features/:id`

| Status | Body | When |
|---|---|---|
| 200 | `{ "ok": true }` | Deleted |
| 404 | `{ "error": "not found" }` | Unknown id, foreign tenant, or a repeat |
| 409 | `{ "error": "An agent is working this card. Stop it first, then delete." }` | A run is queued, starting, or running |
| 502 | `{ "error": "the sandbox could not be destroyed (...). The card was not deleted; try again" }` | `driver.destroy` threw; nothing changed |

## Where the plan was wrong

### 1. The delete order it specified cannot run

The plan had the route delete the sandbox rows and then the feature row.
That fails on every card that has ever run:
`agent_runs.sandbox_id` references `sandboxes.id` with `on delete no
action` (`packages/db/migrations/0000_bento.sql:305`), and the run
executor sets that column, so removing the sandbox first raises

```
update or delete on table "sandboxes" violates foreign key constraint
"agent_runs_sandbox_id_sandboxes_id_fk" on table "agent_runs"
```

Confirmed by running the plan's order against real Postgres, not
reasoned about: the worked-card test fails with exactly that error.

Simply swapping the two does not work either, because
`sandboxes.feature_id` is `on delete set null`, so after the feature is
gone `delete from sandboxes where feature_id = ...` matches nothing and
leaves the row behind.

What shipped: read the card's sandbox rows first, destroy the machines,
delete the feature row (which cascades the runs and sets those rows'
`feature_id` to null), then delete the sandbox rows **by id**. The
plan's reason for deleting them explicitly rather than by cascade still
holds, and the orphan count it wanted to keep at zero stays at zero.

One related correction: the route reads *all* the card's sandbox rows,
not only the ones that are not `destroyed`. It destroys the live ones
and deletes all of them, because a `destroyed` row left behind with a
null `feature_id` is the very signal that is supposed to mean "a machine
is adrift".

### 2. The deleting tab told itself its card had been deleted

The plan and the design both assumed the tab that pressed Delete clears
its own selection before its copy of the board event arrives. It does
not. The server emits on the bus inside the handler, so the stream beats
the HTTP response, and in the browser the deleting tab showed both
"Deleted “...”." and "The card you had open was deleted." The second
message exists to tell somebody a colleague removed what they were
reading, so sending it to the person who did it is the one thing the
design was careful to avoid.

Found by driving two real tabs, not by a test. Fixed with an
`onDeleting(featureId)` claim the drawer makes before the request, which
the board stream's handler checks; the claim is released when the delete
is refused, so a later delete by somebody else is still announced.

## Tests

- **`auth.e2e.test.ts`**: `DELETE /api/features/:id` joins the matrix,
  last in the list, plus a post-check that the owner's card is still
  there. A route that answered 404 and deleted anyway would pass the
  loop and fail the post-check.
- **`e2e.test.ts`**, against real Postgres: a fresh card deletes and a
  repeat is 404; a worked card takes its runs, transcript, history and
  sandbox row with it, records a `destroy` call for the right machine,
  leaves no null-`feature_id` sandbox row, and leaves its branch in the
  checkout; a card with a queued or running run is refused with exactly
  `CARD_BUSY_DELETE` and is untouched; a driver whose `destroy` throws
  gets a 502 with the card and its sandbox row intact; `startRunIfIdle`
  answers `"gone"` for a deleted card, and the runs, quick-run and
  message routes answer 404.
- **`apps/web/src/delete-card.test.ts`** (new): the focus rule in board
  order, and every clause rule in the dialog copy, including the spend
  clause disappearing when no run reported a cost and the plural for two
  pull requests.
- **`packages/sandbox/src/sprite.test.ts`**: `destroy` tolerates a
  sprite that is already gone and rethrows everything else.

`pnpm test` passes across the workspace.

## Verified by hand, because green tests have lied here before

Driven in a real browser (Chromium, two and three tabs) against a real
server, local mode, a real Postgres, and a real card that had run:

- The card leaves both tabs with no reload, and only the tab that
  pressed the button says "Deleted “...”.".
- A second tab holding that card's drawer gets it closed and is told.
- A session tab on that card says "This card was deleted.", not "check
  that the server is reachable".
- Focus lands on the neighbouring card, confirmed by reading
  `document.activeElement` after the delete: a `[data-feature]` button,
  never `<body>`.
- Two tabs confirming the same delete at once: one gets "Deleted “...”.",
  the other "That card was already deleted.", and neither board keeps a
  ghost row.
- An emptied backlog reads "Add a card" while another lane holds a card.
- With a run active, the button is disabled, its `title` is the sentence
  Approve already uses, and the same sentence is in the visually hidden
  element its `aria-describedby` points at.
- The dialog on a card with one run, a branch and a recorded cost reads
  as designed, naming the figure and the branch.
- In Postgres afterwards: `select count(*) from sandboxes where
  feature_id is null` is 0, and the deleted card's branch is still in
  the source checkout while its worktree is gone.
- The TUI, driven through a pty against the same server: with a card
  selected by keypress and then deleted from the web console, the
  highlight moves to the card that took its place and the notice reads
  "That card was deleted."

**Not verified, and why.** Two of the plan's manual checks could not be
run in this environment:

- `docker ps -a --filter label=dev.bento.feature=<id>` after a delete.
  There is no Docker daemon here, so the destroy path was exercised
  against the local-process driver and against a stub that records and a
  stub that throws. `DockerDriver.destroy` is unchanged by this work and
  already tolerates a 404 the way the plan describes, but it remains the
  one production driver this route has never actually called. Worth ten
  seconds on a machine with Docker before this is trusted on a hosted
  deployment.
- A real pull request surviving the delete. No GitHub connection here.
  Nothing in the route touches `packages/github`, and there is no close
  path in it to call, so the guarantee rests on there being no code that
  could break it.

## Known, accepted, unchanged from the plan

- The delete is irreversible and takes recorded spend with it, so the
  project total moves. The dialog names the figure first.
- Destroy succeeds and the commit then fails: the machine is gone and
  the card survives claiming otherwise. Rare, recoverable, and strictly
  better than the inverse.
- Runner-executed cards: the server cannot reach a sandbox on somebody
  else's laptop, so that container is left to the runner's own
  lifecycle.
- The board event is emitted just before the tenant transaction commits
  in multi mode, the same window every existing emitter has.

One small thing observed while driving the TUI: on a board with no agent
assigned, the standing "No stage has an agent" notice overwrites "That
card was deleted." at the next three second refresh. That is how
standing notices have always behaved and no part of this change touches
it; on a configured board the delete notice lives out its six seconds.

## Out of scope, as the earlier stages set it

Archive or cancel (Need B), title and description editing, deleting
branches or closing pull requests, undo, bulk delete, project delete, a
sandbox reaper, and delete controls in the TUI or the Mac app.
