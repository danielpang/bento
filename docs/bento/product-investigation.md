# Show card description

A person can write a description when they create a card. After that, no client shows it again. This investigation asks whether that is a hole worth closing, and what "view after creation" should mean.

## Recommendation

Build it. Show the stored description in the web card drawer, and only when one exists. Do not put the full text on the board card. Do not add editing in this feature.

The evidence is the product itself, not usage counts. Bento already treats description as the agent's brief, indexes it in search, and writes Linear and Slack context into it. Humans are the only readers who cannot see it.

## Who has this problem

Three people keep hitting the same missing field.

**The person who filed the card.** The New card dialog says the description is "the detail the agents work from." After Add, that text is gone from the console. They cannot check what they actually asked for without leaving Bento.

**The person who opens the card later.** Approving, rejecting, sending back, or reading a failed run all happen in the drawer. The drawer shows title, stage, status, branch, actions, and the transcript. It does not show the original request. A teammate who did not file the card has no first-party brief.

**Anyone whose card did not start in the New card dialog.** Linear import writes the issue body and URL into `features.description`. Slack writes `Created from Slack: <permalink>` there. Those are the only copies of that context on the card, and they are invisible in every client.

The Mac app and the terminal never show a description either. Mac cannot even enter one: New card is a title field only. The terminal cannot create cards. Those clients trail the web console by design ([docs/clients.md](../clients.md)), so they are not the first surface.

## What they do today

The field is real. It is stored on `features.description`, returned on list and get, and sent to every agent as `Feature description:` in the stage prompt. Search matches it. Linear outbound copies it onto the issue. There is no PATCH for title or description, so it is write-once from the API.

What a person does when they need that text back:

- Open Linear, if the card was imported or mirrored, and read the issue there.
- Open the Slack thread, if the card was created from a mention.
- Scroll the agent transcript, hoping the prompt or the agent's first message echoed the brief.
- Restate the request in a follow-up on the card.
- Put the important detail in the title so it stays on the board. That is the failure the title/description split was written to stop.

The split is documented in `NewFeatureDialog`: one field used to become the title, so a card with any detail had a title several lines long, and the board showed that wall of text. Description exists so the title can stay short. Hiding it from the board was intentional. Hiding it from the drawer was not argued anywhere. It is just absent.

Search already assumes a person might look for words that live only in the description. A match on invisible text is how a card appears selected with no explanation.

## What the change should achieve

After a card exists, a person looking at that card can read the same description the agent received.

Concretely:

- Opening a card that has a description shows that text in the drawer, above the actions that depend on it.
- Opening a card with an empty description does not grow a blank box or an "add a description" prompt. Empty stays empty.
- Linear-imported cards show the issue body that was stored at import.
- Slack-created cards show the stored Slack permalink.
- The board stays a scan of titles, status, spend, and PR. It does not grow a paragraph per card.
- Search keeps matching description. A person who finds a card that way can open it and see why.

Success is not "more cards have descriptions." Description stays optional. Success is "when one was written, a human can read it without leaving the card."

## How anybody would know it worked

1. Create a card with a title and a description, open it. The description is in the drawer, word for word.
2. Create a card with only a title, open it. No description section appears. The drawer does not look broken or unfinished.
3. Open a Linear-imported card that stored an issue body. That body is visible.
4. Search for a phrase that exists only in a description. The card matches, and opening it shows the phrase.
5. Look at a seven-column board. Cards are still title-plus-meta. Lanes do not get taller because of description text.

If step 1 fails, the feature did not ship. If step 2 or 5 fails, the old wall-of-text problem is back in a new place.

## What we are deliberately leaving out

- **Editing.** There is no update API for title or description. Editing means a new route, a decision about Linear echo, and a story for a card that already ran against the old text. Viewing does not need any of that.
- **The board card body.** The title/description split exists so the board does not render the brief. Putting the full description back on the card undoes that on purpose.
- **Mac and terminal.** Web first. Mac's line protocol is `feature|...|title` with no description field. The terminal detail pane is title, status, then logs. Those are follow-on clients.
- **Making description required.** The create dialog calls it optional. Slack and a title-only Mac card will keep producing empty ones.
- **Markdown, images, or @mentions in the description.** Linear bodies can be rich. Render as plain text (or the same markdown the rest of the drawer already trusts) only if design asks for it. Not a reason to block view.
- **Showing the description in the pull request.** Stage notes already have a setting for that. The card brief is a different document.
- **Analytics on how often descriptions are written.** The connected PostHog project is not this product. Server-side `feature card created` does not record whether a description was present. We are not blocking on a count we cannot see.

## Approaches

### A. Drawer only, when a description exists (recommended)

Add a Description section to `FeatureDrawer`, under the title and meta, before Actions. Use the description the board already has on the feature row. No API change.

Why this: the drawer is where a person already goes to understand a card. The data is already on the client. The board stays short. Empty cards do not grow UI.

Cost: a person scanning the board still cannot tell which cards have a brief. They open one to find out.

### B. Drawer, plus a one-line hint on the board card

Same as A, and a card with a description shows a faded first line (or a small "has description" mark) under the title.

Why someone would want this: search and Linear imports would stop being surprises. Why not: seven-column boards are already tight; a second line of prose competes with status, spend, PR, and the live agent line. A mark without text is easy to miss and easy to over-design.

### C. View and edit

A plus an edit control and `PATCH /api/features/:id`. Then: does an edit rewrite the Linear issue, and does a running agent see the new text?

Why not now: the request is to view what was entered. Editing is a different product question (is the description a snapshot of the original ask, or a living spec?). Guessing that here would invent Linear and mid-run behaviour the evidence does not specify.

## Decision needed

Pick the surface before design starts.

**Should a person read the description only after they open the card (A), or also get a hint on the board (B)?**

This write-up assumes A. If the brief must be skimmable without opening a card, say so and we take B. Do not take C unless you also want to define edit-after-run and Linear sync.

Do not skip the feature. A field the create dialog, search, Linear, Slack, and the agent prompt all treat as the brief, and that no human UI will show, is a defect. The only honest reason not to build is "description is write-only machine context." That is not how the product describes it today.
