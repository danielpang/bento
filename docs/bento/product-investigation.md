# Large multi-tasks — product investigation

Bento models work as **one card, one branch, one sandbox, one agent at a time**. That is a deliberate invariant, and it is the right shape for a change that one agent can finish. It is the wrong shape for work that has to become several changes before anyone should implement it.

This write-up is an investigation, not a design. The evidence is the product as it ships today, including this card. There are no customer interviews and no usage numbers behind what follows.

## Who has this problem

Three people, and they are not the same person.

**The person who files work.** They create a card from the board, Slack (`@bento add …`), or Linear. Intake has one title and one description. Nothing asks whether this is one change or several. Linear already has parent and child issues; Bento's importer never reads that relationship, so a Linear epic and its children land as unrelated cards, or the epic lands alone and the children never arrive.

**The first agent on the card.** On a new project that is the Product Manager. The seeded stage goal is to "investigate the problem space and generate feature ideas." Those ideas have nowhere to go except a markdown file on this card's branch. The agent cannot create cards: the sandbox has no Bento API and no board MCP. The next stage (design) therefore inherits one card whose scope is whatever the investigation happened to contain.

**The person watching the board.** They can see every card, each card's stage, spend, and pull request. They cannot see that five cards are one initiative, that one of them is the reason the others exist, or that the parent is "done investigating" while the children have not started. Spend is per card and per project, never per group. Hosted plans also stop a single card at **24 agent hours** in a period, on the assumption that anything longer is a loop. Legitimate large work on one card looks like a runaway to billing.

This card is the problem in miniature. "Design a way to model larger features" is one card walking a six-stage pipeline. If the investigation produces three separable ideas, the designer, staff engineer, and implementer will each be asked to do all three on one branch, or a human will split the work by hand with no link back to this card.

## What they do today

There is no parent, child, related-to, or blocked-by column on `features`. The board is a flat list of cards in lanes. Creating a card takes a project, a title, and a description.

What people and agents actually do:

1. **Leave it as one card.** The agent tries to do everything on one branch, in one sandbox, through every stage. Multi-repo already covers "this change touches web and api" as one card; that is not the same problem. The failure mode here is scope, not repository count. One agent at a time; a second run on the same card is refused as busy. Context grows. The 24-hour card ceiling can fire on work that is slow rather than stuck.

2. **Split by hand.** A person reads the investigation (or never waits for one) and files more cards. Those cards do not know each other. Each gets its own branch, sandbox, setup cost, and pipeline. Nothing stops two of them from editing the same files. Nothing tells the original card it is finished splitting. Linear will file a new issue per card if that project creates issues, still without a parent.

3. **Encode the split in prose.** The investigation lists "feature ideas" in `docs/bento/product-investigation.md`. Later stages are told to build what the previous stages describe. A careful implementer might do one idea and leave the rest; a less careful one attempts all of them. The board still shows one card.

4. **Do not file the large thing at all.** Work that looks too big stays in Linear, a doc, or a conversation until a human carves it into cards Bento can run. Bento never sees the large task.

Agents have no fourth option. They cannot spawn cards, they cannot attach a card to another, and they cannot mark a card as a container.

## What the change should achieve

A large piece of work should be visible as a whole and runnable as parts.

Concretely:

- A person or an agent can say "this card is larger than one change" and produce **real cards** for the parts, not only a list in a write-up.
- Those parts are **linked** to the work that created them, so the board can show the group and a reviewer can open the parent and see the children.
- Each part keeps today's invariant: **one card, one branch, one sandbox, one agent**. The large task is a relationship between cards, not a second kind of sandbox.
- Somebody looking at the parent can tell whether the parts have been created, whether they are moving, and whether any have failed, without opening each child.
- Hosted spend still makes sense: hours belong to the card that ran them; a group total is a sum, not a new ceiling to game.

The change should not try to become an agent operating system. Tracking every worktree, validating a combined diff, scheduling children in dependency order, and merging N pull requests as one are follow-on problems. They are only worth building after a group of cards has existed long enough for someone to say which of those they actually missed.

## Feature ideas

These are options, not a recommendation to build all of them.

### A. Linked cards, people only

Add a parent on a feature. The board groups children under it, or the drawer lists them. Only a person creates and links cards. Agents keep writing ideas into markdown.

Cheap. Unblocks the human who already splits by hand. Does nothing for the first agent, and does not fix the seeded "generate feature ideas" dead end.

### B. Agents may create cards

Give a run a way to create a card in the same project (a narrow MCP or an internal tool). Optionally set the parent to the card that is running. The new cards land in the backlog. The parent finishes its stage as an investigation that spawned work, not as the work itself.

This is the smallest change that matches the seeded pipeline. The risk is a chatty agent flooding the board. Creation should be a tool the skill asks for, with a title and a description, not a free-form "build this epic" loop.

### C. Parent as container

The parent is not a working card. It has no branch, no sandbox, and does not walk the six stages. Children do. The parent is done when its children are done (or cancelled). Creating the children *is* the first stage.

This is the cleanest model if "large" means "several features." It is also a new kind of object, and every client (web, TUI, Slack, Linear, billing) has to learn it. Do not start here unless the decision below picks a container.

### D. Do not build a model

Change the Product Manager skill to "name the cards a person should file, then stop." Teach intake to file smaller cards. Rely on Linear for hierarchy.

This is the right call if the pain is only "agents write long investigations." It is the wrong call if we want Bento to be where the split happens, because the split then lives outside the product that runs the parts.

## How anybody would know it worked

Not "we shipped parent ids." These are the checks that would make the feature real:

1. A person can open a parent and see its children, their stages, and whether any agent is running, without hunting the board.
2. An investigation that produces two ideas can leave two cards on the board that later stages can pick up independently. Those cards exist as rows, not as headings in a markdown file.
3. The original card does not continue into implementation carrying both ideas on one branch, unless a person explicitly chooses that.
4. Deleting or finishing the parent has a defined effect on children (keep them, cancel them, or refuse) and that effect is visible before it happens.
5. Spend on the group equals the sum of spend on the cards. A child does not inherit the parent's 24-hour clock; a parent that only investigates does not burn toward that ceiling on the children's behalf.
6. A team that still files one small card sees no new ceremony. Hierarchy is opt-in.

If we cannot describe a card that would fail those checks, we are not ready to build.

## What this is deliberately leaving out

- Dependency graphs, blockers, and "child B starts when child A is done."
- Sharing or stacking worktrees across cards. Each child is a normal card.
- Combining child pull requests into one, or merging in a parent-defined order.
- Recursion past one level (grandchildren).
- Automatic re-aggregation of child write-ups into a parent verdict.
- Changing Linear's importer to round-trip parent/child. Worth doing later if we have a parent in Bento; not a reason to invent one.
- Billing policy changes. The 24-hour card ceiling stays a loop guard. Splitting work must not become a way around a team allowance; the team allowance already sums every card.
- A new pipeline type, a new board, or parallel agents on one card.

## When not to build this

The evidence **does not** support building a coordinator that splits work, watches every worktree, and validates combined output as a first feature. That is several products stacked on a relationship we have never shown a user.

The evidence **does** support a hole in the current model: the first stage is asked to generate feature ideas, and the product has no type for more than one idea. That hole is visible without interviews. It is visible on this card.

If the decision is that Bento cards are always one change, and large work is the user's problem to carve up before it reaches the board, then **do not build hierarchy**. Edit the Product Manager skill and the stage description so they stop promising multiple feature ideas, and stop this card before design.

## Decision needed

Please pick one. Design cannot start without it.

**What is a large task in Bento?**

1. **A working card with children.** The parent keeps a branch and a pipeline. Children are extra cards it created. The parent can still move through design and implementation on its own, which is useful for a thin slice plus follow-ups, and dangerous if later stages treat the parent as "do everything."
2. **A container.** The parent does not run implementation. Spawning children is the work of the first stage. Later stages run only on children.
3. **Not a type.** Do not model this. People file smaller cards. Close this feature.

A second, smaller decision if the answer is 1 or 2:

**Who may create the child cards?** People only (idea A), or agents as well (idea B)?

My read, not a substitute for the decision: **2 and agents as well**, because that is what the seeded pipeline already describes, and because a parent that keeps walking the full pipeline will re-create today's failure with more rows underneath it. If that is too large, ship **1 with people only** and treat agent creation as a second card.

I am not choosing 3. The contradiction between "generate feature ideas" and "one card is the feature" is in the product we ship, not in a customer quote we lack.
