# Delete card: product investigation

## What I found first, because it changes the question

A card is the only entity in Bento that cannot be removed by any means
short of deleting the whole organization. There is no `DELETE`, no
`PATCH`, and no cancel on `/api/features/:id`
(`apps/server/src/routes/features.ts:128`). Stages, repositories, agent
profiles, secrets, and the GitHub installation all have a delete route.
Cards do not.

Two things in the codebase say this was an oversight rather than a
decision:

1. **The product already promises a way out and cannot deliver it.**
   `features.status` has a `cancelled` value
   (`packages/db/src/schema/app.ts:226`). Nine route guards refuse
   actions on a cancelled card, all three clients style one, and the Mac
   app renders the sentence "This card was cancelled. It has no further
   actions." (`apps/mac/src/app.native:228`). Nothing anywhere sets it.
   Every write to `features.status` sets `active`, `gated`, or `done`.
   The state is unreachable, so all of that code is dead.
2. **The organization delete dialog already lists cards as deletable.**
   "Every project, card, agent, and credential in this organization goes
   with it" (`apps/web/src/components/AccountSettings.tsx:102`). That is
   the only supported way to delete a card today, and it takes the team
   with it.

So the request is not "add a nice-to-have". It is "close a hole that the
rest of the product is already written around".

## Who has this problem

I can name three groups from the shape of the product. I want to be
plain that this is inferred from the code and the docs, not measured:
this repository has no analytics of any kind, and feature requests arrive
as email to `BENTO_CONTACT_EMAIL`
(`apps/server/src/routes/contact.ts:26`), which I cannot read. If
somebody has that mailbox, the fastest way to check my reasoning is to
search it for "delete" and "remove card".

**1. Anybody who has just installed Bento.** The board's empty state is
a button reading "Add your first card"
(`apps/web/src/components/Board.tsx:403`). The documented first run is
"Add a card, describe the feature, and advance it" (`README.md:54`). The
first card a person makes is a test, and it is permanent. This is the
group I am most confident about, because the product instructs them into
the problem on their first minute and every install has one.

**2. Whoever mistypes.** Title and description are set at creation and
there is no path back to either field (`NewFeatureDialog`, then
`client.createFeature`). A typo in a title, a card filed against the
wrong project, or a double submit produces a card that can only be
advanced, never corrected and never removed. Note that "I cannot edit
the title" may be the actual complaint behind some "let me delete this"
requests, and it is a much smaller feature.

**3. Teams whose board fills with work that was never built.** Cards
enter the backlog, and the only exits are forward through the pipeline
or into the Done lane. A decision not to build something has nowhere to
go. Over a quarter that means the backlog lane is part inbox and part
graveyard, and the only tool for telling them apart is the topbar search
(`apps/web/src/components/Board.tsx:238`), which is not persisted
(`apps/web/src/App.tsx:202`). This group's need is arguably not delete
at all: see "Two needs wearing one word".

## What they do today

- **Leave it.** A wrong card sits in the backlog forever. The lane
  header counts it (`Board.tsx:420`), so the number a team glances at is
  wrong by however many mistakes they have made.
- **Push it through the pipeline to get it out of the way.** This works
  and is the worst outcome available, because it burns real agent spend
  and can open a pull request on a stage with `createPr` set. The board
  then records the mistake as finished work.
- **Delete the organization.** The only true delete. Named in the
  dialog, and obviously not a real answer.
- **Edit Postgres by hand.** Available to self-hosters, which is a large
  share of this product's users given it ships as `docker compose up`
  (`README.md:15`). It is also the reason nobody has filed this loudly:
  the people most able to hit the problem are the people most able to
  work around it, silently, with `delete from features where id = ...`,
  which leaves every one of the orphans catalogued below.

## What the change should achieve

A person who can see a card can make it stop existing, without side
effects they would not have predicted, and without a route that fails
halfway.

Concretely:

1. A card that was created by mistake can be removed and is genuinely
   gone: no row, no lane count, no entry in any list.
2. Removing a card never leaves Bento paying for something. Today
   nothing in this codebase ever destroys a sandbox: `driver.destroy` is
   implemented for Docker, Sprite, and local process and is called from
   no server code (`packages/sandbox/src/docker.ts:232`,
   `packages/sandbox/src/sprite.ts:358`). A hosted card's sandbox is a
   billable Fly machine named `bento-<featureId>`, and `sandboxes.feature_id`
   is `on delete set null` (`packages/db/src/schema/app.ts:342`), so a
   bare row delete makes that machine unreachable from every query in
   the product while it keeps running.
3. Removing a card never destroys the user's code. The branch is the
   only surviving copy of the work: `collectFeatureChanges` reads the
   diffs and the `docs/bento/` write-ups from it rather than from the
   sandbox (`apps/server/src/feature-changes.ts:34`). Deleting a card
   should not delete a branch and should not close a pull request.
4. A card cannot be deleted out from under a working agent, or if it can,
   the agent stops first. A live run holds an `AbortController` in
   `ctx.running` and keeps executing with no further look at the
   `features` table, so a delete mid-run leaves an agent burning tokens,
   an SSE stream that never receives its `done` event
   (`apps/server/src/routes/runs.ts:358`), and `run_events` inserts that
   fail on a foreign key.
5. Every open board loses the card without a reload. `BoardEvent` today
   is only `feature_updated | run_updated | run_output`
   (`apps/server/src/events.ts:11`). There is no removal event, so
   deleting a card leaves it on every colleague's screen indefinitely.
6. The delete is refused for a foreign tenant with a 404, and refused
   again on a repeat with a 404 rather than reporting success for a row
   it did not touch. The profiles route already argues both points in
   comments worth copying (`apps/server/src/routes/profiles.ts:203`
   and `:240`).

## How anybody would know it worked

Behavioural, and honestly weak because there is no analytics: the signal
available is that installs stop accumulating cards nobody advances. If
telemetry is ever added, the measure is the share of cards created and
then never advanced, which should fall.

Observable now, and these are the checks I would actually run rather
than trust a green test suite (`AGENTS.md` is explicit that type checks
and passing tests have agreed with each other while the feature did not
work):

- Delete a card in one browser tab and watch it leave a second tab's
  board without a reload.
- Delete a card that has run, then `docker ps -a --filter
  label=dev.bento.feature=<id>` returns nothing.
- `select count(*) from sandboxes where feature_id is null` is zero
  after the delete, and `select count(*) from run_events` has dropped by
  the transcript's size rather than left orphans.
- The card's branch still exists in the source checkout, and any open
  pull request is still open. This is a pass, not a leak.
- The same `DELETE` from a second organization's session returns 404,
  through the matrix test in `auth.e2e.test.ts` that `AGENTS.md` requires
  a new route to join.
- Repeating the `DELETE` returns 404.
- Delete a card while an agent is mid-run, and observe whichever of
  "refused with 409" or "run aborted, then deleted" we choose. What must
  not happen is a 200 with an agent still running.

## Two needs wearing one word

The single strongest finding of this investigation is that "delete card"
is two requests, and building one verb for both would be a mistake.

**Need A: undo a mistake.** The card has no runs, no branch, no pull
request, and nothing outside its own row. Deleting it is cheap, has no
side effects, and is unambiguously correct. This covers the onboarding
test card and the mistyped card, which is where I believe most of the
demand is.

**Need B: get finished or abandoned work off the board.** The card has
transcripts, recorded spend, a branch, maybe open pull requests. Delete
is the wrong verb for this and is actively lossy in a way users will not
predict: project spend is computed by joining runs through features
(`apps/server/src/routes/projects.ts:494`), so deleting a card that cost
forty dollars silently reduces the project's total by forty dollars. The
money was still spent. Bento's own docs frame spend as informational and
never enforced (`docs/concepts.md:26`), which softens this but does not
remove it: a monthly figure that changes because somebody tidied the
board is a trust problem.

Need B is what `features.status = "cancelled"` was evidently meant to
serve, and it is already half built across three clients. My reading is
that it wants to be its own card, and that it is the higher-value one,
because it is the need that recurs weekly rather than once per install.

## What I am deliberately leaving out

- **Editing a card's title or description.** Adjacent, cheaper, and
  possibly the real request behind some delete asks. Out of scope, and
  worth its own card.
- **Deleting branches, local or remote.** Bento would be deleting the
  user's code. Recommending against it, not deferring it.
- **Closing pull requests.** There is no close path anywhere in
  `packages/github` and no webhook reaction to `pull_request.closed`.
  Out of scope.
- **Undo, trash, or a restore window.** Every existing destructive action
  in this product is a confirm dialog and then gone, and each says so in
  its copy. Matching that is cheaper and more honest than a trash can
  nobody empties. `features` has no `deleted_at` and would be the first
  table in the schema to need one.
- **Bulk delete and multi-select.** Boards here hold tens of cards, not
  thousands.
- **Deleting a project.** Also missing, also only reachable by deleting
  the organization, and a bigger job. Separate card.
- **A general sandbox reaper.** A card delete needs to destroy one
  sandbox. It does not need the scheduled reclamation of idle sandboxes
  that this product is also missing, though it would be the first caller
  of the same `destroy` path.
- **Retaining spend after a delete.** Excluded by the recommendation
  below, and reversible if the answer to the first decision below is
  different.

## Decisions I need before design starts

I am not guessing at these. Each changes the shape of the work.

1. **When a card that has run is deleted, may its recorded spend
   disappear from the project total?** My recommendation is yes, and
   accept it, because the alternative is a `deleted_at` column and a
   filter on every features query in the product forever. If the answer
   is no, the feature becomes a soft delete and Need B above collapses
   into it, which is a larger and different piece of work.
2. **Delete under a live run: refuse, or cancel then delete?** My
   recommendation is refuse with 409, reusing the `CARD_BUSY` shape the
   run routes already use, because "stop the agent, then delete" is one
   extra click and zero ambiguity, and because a delete that also
   silently kills a running agent is a lot of consequence behind one
   button.
3. **Who may delete a card?** Every member of an organization sees all
   of its projects and there is no per-project sharing
   (`docs/concepts.md:30`). Secrets restrict destructive actions to
   owners and admins with a 403
   (`apps/server/src/routes/secrets.ts:114`), and stages do not. My
   recommendation is any member, matching stages, on the grounds that a
   board a team shares is a board a team tidies. Say so if cards are
   meant to be more protected than that.
4. **Should Need B be built as the same card or a separate one?** My
   recommendation is separate, and next. I would like agreement rather
   than to quietly widen this card's scope.

## Should we build this at all

Yes, for Need A, and I would say so even without a single user request.
The argument does not rest on demand: it rests on the product being
internally inconsistent. Every other entity is deletable. A state the
schema and all three clients handle is unreachable. The organization
delete dialog already claims cards can be deleted. That is a hole, and
holes like this are cheap now and expensive after the first customer
discovers that the fix is `delete from features` by hand, which orphans a
running Fly machine they will be billed for.

Where I would push back: if this card is read as "delete anything,
including a card with a month of agent history", the honest answer is
that the prerequisite does not exist yet. Nothing in this codebase has
ever destroyed a sandbox, removed a worktree, or deleted a branch, so a
card delete would be the first caller of paths that have never run in
production, and the leftovers are silent and metered. That is a good
reason to scope the first version tightly and verify it against a real
Docker daemon and a real Postgres rather than against the test suite.

## What the next stage inherits

The one line to carry forward: **delete the row and destroy the sandbox,
never the branch and never the pull request, refuse while an agent is
running, and emit a board event so the card leaves everybody's screen.**

Design should also know that the drawer's `Actions` section
(`apps/web/src/components/FeatureDrawer.tsx:220`) is where every card
verb already lives, that `ConfirmDialog` with `destructive` is the
established pattern for this
(`apps/web/src/components/PromptDialog.tsx:424`), and that the card face
on the board has no per-card controls and no context menu today, so
putting a delete there would be a new interaction pattern rather than a
new button. The TUI and the Mac app both act on cards through single
keys and small button rows, and neither has any card creation or removal
at all, so leaving them out of the first version is defensible as long
as it is a decision rather than an omission.
