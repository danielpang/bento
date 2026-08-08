# Delete card: design

Working from `docs/bento/product-investigation.md`. The line it handed
forward is the one this design is built on: **delete the row and destroy
the sandbox, never the branch and never the pull request, refuse while
an agent is running, and emit a board event so the card leaves
everybody's screen.**

Everything below is the web console unless it says otherwise. The last
section says what the TUI and the Mac app do, and why they do nothing.

## The decisions this design assumes

The investigation ended with four open questions. Three of them change
what is on screen, so I have taken a position on each and marked how
much of this design falls over if product answers differently.

1. **Spend disappears with the card.** Following the recommendation: a
   hard delete, no `deleted_at`. The design's response is not to hide
   this but to say it out loud in the confirm dialog, with the actual
   figure. A total that moves because somebody tidied the board is a
   trust problem when it happens silently; it is an informed choice when
   the dialog names the number before the click.
2. **A live run refuses the delete.** Following the recommendation
   (409). Design goes one step further: the button is disabled while an
   agent works, with the reason on hover, so almost nobody reaches the
   refusal. The 409 still needs copy, because a run can start between
   the render and the click.
3. **Any member may delete.** Following the recommendation, matching
   stages rather than secrets. This means there is no permission denied
   state in the shipped design. I have designed one anyway, because the
   brief asks for it and because it is the only part of this that
   changes if product picks owners and admins instead. It is written as
   a drop in variant, not as a rewrite.
4. **Need B ("get finished work off the board") is a separate card.**
   Following the recommendation. Nothing here revives
   `status = "cancelled"`, and no copy in this design uses the words
   archive, hide, or cancel for what delete does. That vocabulary is
   reserved so the next card can use it.

## Where the control lives, and where it does not

**In the drawer, at the end of the Actions section, below a hairline
rule.** `FeatureDrawer.tsx:220` is where every card verb already lives,
and a person looking for a verb looks there. Placing it inside Actions
keeps it findable without scrolling past the gate, the history, the diff
and the whole transcript, which is what putting it at the foot of the
drawer would cost.

Below a rule, and styled quiet (a ghost button that only takes the
danger colour on hover and focus) because it is not a peer of "Approve
and advance". The action grid is a set of things you do to move work
along. This is the one that ends the card, so it is in the same room and
not in the same row.

**Not on the card face.** The board's cards have no per card controls
and no context menu, so a delete there would be a new interaction
pattern for every card rather than a new button on one. It also puts a
destructive action under the pointer during a drag between lanes.

**No keyboard shortcut.** The web console has no card level shortcuts at
all today. Delete would be a strange one to introduce first, and the
Delete key over a focused card is exactly the accident this product has
no undo for.

**One door.** A card is deleted from its own drawer, and from nowhere
else.

## The states, in order

### 1. The board, before anything

Unchanged. No badge, no new affordance, no change to the card face. The
entry point is opening the card, which is already how everything else on
a card is reached.

### 2. The drawer, Actions section

A rule, then a single row:

```
────────────────────────────────────
Delete card
```

Four variants, decided by what the drawer has already loaded.

**a. A card nothing has run on** (no runs, no branch, no pull requests).
Button enabled. No explanatory text: there is nothing to warn about
until the dialog, and a paragraph beside a button on an untouched card
is noise on the commonest case in the product, which is the first test
card somebody made ten minutes ago.

**b. A card that has been worked** (one or more finished runs). Button
enabled, identical. The consequences belong in the dialog, where they
are read, and not next to a button somebody has not pressed yet.

**c. An agent is working the card** (`runActive`, the same flag
"Approve and advance" already uses). Button disabled, `title` and
`aria-describedby` carrying:

> An agent is working this card. Stop it or wait for it to finish.

Word for word the sentence the Approve button already uses, because two
sentences for one condition read as two different conditions. Stop lives
next to the composer in the conversation below, which is on screen in
the same drawer, so the instruction points at something visible.

**d. The drawer's detail failed to load.** The drawer already says
"Could not load this card's details" at the top. In that state the
button is disabled with:

> Reopen the card first. This cannot be done while its details are
> missing.

The reason is not caution for its own sake: without the runs list the
dialog cannot tell variant a from variant b, and the choice between
those two is the difference between "nothing else goes with it" and a
sentence naming three runs and twelve dollars. A destructive dialog that
guesses which is easier to hear is a dialog that lies.

While the detail is still loading (the normal case, a few hundred
milliseconds) the button is disabled with no title. It becomes live when
the section around it does.

### 3. The confirm dialog

`ConfirmDialog` with `destructive`, exactly as "Undo this run" and
"Delete organization" already use it. No type the name to confirm: every
destructive action in this product is one dialog and then gone, and the
organization delete, which is far larger, does not ask for typing
either. Introducing it here would say a card is graver than the team.

Title, in all variants:

> Delete “{title}”?

Quoted, because a card title is a sentence and unquoted it collides with
the question mark. Titles longer than 60 characters are cut at a word
boundary with an ellipsis; the full title is still at the top of the
drawer behind the dialog.

Confirm label, in all variants: **Delete this card**. Cancel is
`ConfirmDialog`'s own Cancel.

**Variant A, nothing has run:**

> Nothing has run on this card, so nothing else goes with it. It leaves
> the board for everyone in this organization. There is no undo.

**Variant B, the card has been worked.** Built from three optional
clauses so it only ever claims what is true:

> Its 3 runs go with it, transcripts and recorded spend included, so
> this project's spend drops by $12.40. The branch
> `bento/add-a-rate-limit` is left alone, and any pull request stays
> open. Its sandbox is thrown away, and there is no undo.

Clause rules:

- The spend clause (", so this project's spend drops by $X") is dropped
  when no run reported a cost, which is most runs on most tools
  (`CardSpend` already carries this caveat). Then the sentence ends at
  "transcripts and recorded spend included." Naming a figure that is
  actually a floor would be worse than naming none.
- The branch clause is dropped when `branchName` is null.
- The sandbox clause is dropped when the card has no runs, which is
  variant A.

**Variant B plus, the card has an open pull request.** One sentence
added before "There is no undo":

> Bento stops tracking pull request #12. It stays open on GitHub, where
> you can merge or close it yourself.

This is the clause I care most about. The single most predictable wrong
belief about a delete button on a card is that it takes the code with
it. Both directions of that belief are dangerous: somebody who thinks
their branch survives when it does not loses work, and somebody who
thinks deleting the card cleans up GitHub leaves a pull request open and
forgotten. The dialog answers before the question is asked.

### 4. Deleting

The dialog's confirm button disables itself while the request is in
flight (`ConfirmDialog` already does this). No spinner, no label change:
this is a request to a local server that either lands quickly or fails,
not the minute long publish that earned "Creating PR...".

**The card is not removed optimistically.** The board keeps rendering it
until the server says the row is gone. A card that vanishes and then
reappears when the refetch disagrees is a worse failure than a card that
takes 200ms to leave, and this product has already learned that lesson
where the drag between lanes bounces.

### 5. Deleted, on the screen that did it

Three things happen, in this order:

1. The dialog closes.
2. The drawer closes. It closes on its own, with no new code: `App.tsx`
   derives `selected` from the features list, so a card that is no
   longer in the list has no drawer. That is worth knowing rather than
   defending against.
3. The card leaves its lane, the lane count drops, and the cards below
   it travel up into the gap. `useCardTravel` already animates that, and
   it is the whole departure animation this needs. No fade, no shrink,
   no exit transition: the neighbours moving up is the cue, it is
   already built, and it already respects `prefers-reduced-motion`.

And one toast, bottom left, info tone:

> Deleted “Add a rate limit to the public API”.

Titles over 60 characters are cut the same way as in the dialog. The
toast is not decoration. Somebody whose board is scrolled to the Review
lane deletes a backlog card and sees nothing change; the toast is the
only proof the click worked. It is also the screen reader path, because
the toast host is already `aria-live="polite"`.

**Focus** moves to the card that took the deleted one's place in the
lane; if it was last in the lane, to the card above it; if the lane is
now empty, to the lane's own empty state control. `Modal` restores focus
to whatever opened the dialog, and here that button no longer exists, so
without this rule focus lands on `<body>` and a keyboard user loses
their place on the board.

### 6. Deleted, on everybody else's screen

The card disappears from every open board in the project, with no
reload, on the board stream. No toast: a colleague did not do this, and
a message about it would be noise in the middle of their own work. The
card leaving and the lane count dropping is the whole story.

One exception, because silence there would be a bug rather than
restraint: **a viewer with that very card open in the drawer**. The
drawer would otherwise vanish mid sentence while they read a transcript.
They get the drawer closed and an info toast:

> The card you had open was deleted.

### 7. Deleted, in the session tab

`/session/:id` is a separate tab, opened by "Review changes" and by the
transcript's expand link. When its card is deleted, its refetch gets a
404 and the page currently renders "Could not load this card. Check that
the server is reachable and that you are signed in, then reload.", which
sends somebody to check a connection that is fine.

A 404 gets its own state on that page:

> **This card was deleted.**
> It is no longer on the board, and its transcript went with it.
>
> [ Back to the board ]

The button already exists in that page's header. Every other failure
keeps the existing sentence.

### 8. The board's empty state, afterwards

Deleting the last card in the backlog brings back the lane's own empty
state. Today that is always the button "Add your first card", and after
a delete it can be a lie: somebody who has made five cards and deleted
one is not being invited to make their first.

The rule: the CTA reads **Add your first card** only when the board
holds no cards at all, in any lane, and **Add a card** otherwise. That
is one comparison against a list the board already has.

The residual case, said out loud rather than papered over: delete your
only card and the board is genuinely empty again, so it says "Add your
first card" to somebody who has made one before. I am accepting that. It
is a true statement about the board, the screen is indistinguishable
from a fresh install, and the alternative is remembering deleted cards
in order to word a button, which is a `deleted_at` column wearing a
disguise.

Searching is unaffected: a filtered lane with nothing in it still says
"No matches", which is already the distinction the board draws between
"empty" and "filtered".

### 9. Refused: an agent is working the card (409)

Reachable only by a race, since the button is disabled in this state.
The dialog closes, the card stays exactly where it is, and a failure
toast carries the server's sentence:

> An agent is working this card. Stop it first, then delete.

This needs to be its own message rather than the existing `CARD_BUSY`
string, which reads "an agent is already working this card; wait for it
to finish or cancel it first" and is written for somebody trying to
start a second run. "Wait for it to finish" is advice about the wrong
thing here: waiting does not delete the card.

### 10. Already gone (404)

Two different situations return 404 and get one message, deliberately:
the card was deleted a moment ago in another tab, and the card belongs
to another organization. The second must not be distinguishable, or the
route becomes a way to ask whether an id exists.

> That card was already deleted.

The board refreshes behind the toast, so the stale row leaves the screen
at the same moment. This is the one failure that ends with the card
gone, which is what the person wanted anyway.

### 11. Not allowed (403), if product overrules decision 3

Not in the shipped design. If cards become owner and admin only, this is
the whole change:

- The button renders, disabled, for everyone else. Hidden controls
  teach nobody that the feature exists, and this console already argues
  that where the publish button explains its own missing setting rather
  than disappearing.
- A sentence under the action grid, in the same shape
  `AccountSettings` already uses for the organization delete:

  > Only an owner or admin can delete a card.

- The same sentence as the failure toast on a 403, for the case where a
  role changed in another tab.

### 12. The request never landed

Network failure, server down, request timed out. The dialog closes and
the toast carries whatever was thrown, which is what `act` in the drawer
already does for every other action. The card is still on the board, so
nothing is ambiguous: the thing that would have gone is still there.

I considered keeping the dialog open with the error inside it, which
`ConfirmDialog` cannot do today. Not worth a new prop here. Nothing was
typed, so there is nothing to lose by closing, and reopening the card is
one click.

## Every string in one place

| Where | String |
|---|---|
| Drawer button | `Delete card` |
| Button title, run active | `An agent is working this card. Stop it or wait for it to finish.` |
| Button title, detail missing | `Reopen the card first. This cannot be done while its details are missing.` |
| Dialog title | `Delete “{title}”?` |
| Dialog body, no runs | `Nothing has run on this card, so nothing else goes with it. It leaves the board for everyone in this organization. There is no undo.` |
| Dialog body, worked | `Its {n} run{s} go with it, transcripts and recorded spend included, so this project's spend drops by ${x}. The branch {branch} is left alone, and any pull request stays open. Its sandbox is thrown away, and there is no undo.` |
| Dialog body, extra clause with an open PR | `Bento stops tracking pull request #{n}. It stays open on GitHub, where you can merge or close it yourself.` |
| Dialog confirm | `Delete this card` |
| Dialog cancel | `Cancel` (from `ConfirmDialog`) |
| Toast, deleted | `Deleted “{title}”.` |
| Toast, deleted elsewhere while open | `The card you had open was deleted.` |
| Toast, run active (409) | `An agent is working this card. Stop it first, then delete.` |
| Toast, already gone (404) | `That card was already deleted.` |
| Toast, forbidden (403, only if decision 3 changes) | `Only an owner or admin can delete a card.` |
| Session page, card deleted | `This card was deleted.` / `It is no longer on the board, and its transcript went with it.` |
| Backlog empty CTA, board has other cards | `Add a card` |
| Backlog empty CTA, board has none | `Add your first card` (unchanged) |

Singular and plural: "Its 1 run goes with it" reads badly, so the one
run case is worded "Its single run goes with it, transcript and recorded
spend included". No em dashes, en dashes or hyphen pauses anywhere
above, per `CLAUDE.md`.

## Keyboard, focus, screen readers, motion

- The dialog is `Modal`, so Radix supplies the focus trap, Escape, the
  backdrop, and the inert page behind. Nothing new is needed.
- Escape in the dialog cancels. Escape with the dialog closed dismisses
  the drawer, which `useDismissable` already gets right by checking for
  a portal layer first.
- The confirm button is not autofocused. `Modal` focuses the panel, and
  the destructive button should not be one Enter away from the dialog
  appearing.
- The drawer's Delete button carries no `aria-label`: its text is its
  label. The disabled states expose their reason through
  `aria-describedby` as well as `title`, because a `title` on a disabled
  button is invisible to a keyboard and to a screen reader.
- Announcements ride the existing polite toast region. Nothing here
  needs an assertive live region: the person just pressed the button.
- Motion is the existing card travel, so `prefers-reduced-motion` is
  already honoured and nothing new needs to check it.

## The other two clients

**Neither the TUI nor the Mac app gets a delete key in this version.**
This is a decision, not an omission. Neither can create a card either,
so neither would gain a matched pair, and both drive cards through
single keypresses where a destructive one sits a fingerslip from `d`
(diff) and `b` (back a stage). Adding an irreversible action to a key
grid with no confirm step is a different design problem than this one.

Both still have to survive a card being deleted somewhere else, and
today neither does cleanly:

- **TUI.** `current` is found by id in the features list, and every key
  handler returns early when it is missing, so after a refresh the
  selected card is gone and the board answers nothing until the person
  presses `j` or `k`. Requirement: when the selected id is no longer in
  the list, select the nearest surviving card in the same order, and
  post the existing notice line: `That card was deleted.`
- **Mac.** Same requirement, back to the card list rather than sitting
  on a card whose every action now 404s. It already has a screen for a
  card with no further actions; this is a sentence in the same place.

## What I did not design

- **Undo, trash, restore.** Excluded by the investigation and by every
  other destructive action in this product. The dialog says "There is no
  undo" because that is true, and a trash can nobody empties would be a
  second board.
- **Bulk select and delete.** Boards here hold tens of cards.
- **Editing a title or description.** Named in the investigation as
  possibly the real request behind some delete asks, and a smaller
  feature. Still a separate card, and this design does not pre empt it.
- **Archive, hide, or cancel.** Need B. Kept out of this design's
  vocabulary on purpose so the next card can have those words.
- **A delete on the project or the lane.** Also missing, also separate.
- **Any change to the card face.** Deliberate: the board's job is to
  show work moving, and a delete affordance on every card would put an
  end button on every piece of live work.

## What this design needs from the API

Nothing in this document works without these, and all four are already
in the investigation's line for the next stage:

1. `DELETE /api/features/:id`, resolving the card through
   `getAccessibleFeature` and answering 404 for a foreign tenant and for
   a repeat, per `CLAUDE.md`. Added to the matrix test in
   `auth.e2e.test.ts`.
2. A 409 while a run is queued, starting or running, with a delete
   specific message (section 9), not the `CARD_BUSY` string.
3. A new board event so the card leaves other screens (section 6).
   `BoardEvent` is `feature_updated | run_updated | run_output` today,
   and a removal cannot be expressed as an update.
4. A 404 on `GET /api/features/:id` that the session page can tell apart
   from a transport failure, so section 7 can say the right sentence.

The drawer already has everything the copy needs: `runs`, `branchName`,
`pullRequests`, and the same spend arithmetic `CardSpend` uses.

## How I would check this design is right

`CLAUDE.md` is explicit that type checks and passing tests have agreed
with each other while a feature did not work, so these are browser
checks, not test cases:

- Delete a card with two tabs open on the same board. It leaves both,
  and only the tab that pressed the button gets a toast.
- Have the second tab holding that card's drawer open. The drawer closes
  and says so.
- Delete a card with the session tab open on it. That tab says the card
  was deleted, not that the connection failed.
- Delete a card while an agent runs on it. The button is disabled and
  says why, and the transcript below it is still moving.
- Delete the same card twice, from two tabs, quickly. The loser gets
  "That card was already deleted" and a board with no ghost row.
- Delete the last card in the backlog. The CTA reads "Add a card" if any
  other lane holds one, and "Add your first card" only on a truly empty
  board.
- Delete a card with a pull request and read the dialog before
  confirming: it names the PR, then go and check the PR is still open
  afterwards.
- Tab to the Delete button with the keyboard, delete, and see where
  focus lands. It should be a card, not the page.
- Read the dialog on a card with three runs and no reported cost. It
  should not name a dollar figure.
