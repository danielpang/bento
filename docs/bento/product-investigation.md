# Large multi-tasks — product investigation

Bento models work as **one card, one branch, one sandbox, one agent at a time**. That is a deliberate invariant, and it is the right shape for a change that one agent can finish. It is the wrong shape for work that has to become several changes before anyone should implement it.

This write-up is an investigation, not a design. The evidence is the product as it ships today, including this card. There are no customer interviews and no usage numbers behind what follows.

## Decision

A card stays a card. It may **spawn new cards associated with it**. There is no separate container type.

Spawning is not the default. An agent does it only when it judges **both**:

1. the task is large, and
2. the work can and should be divided because that would be more efficient than one agent on one branch.

If either is false, the card stays one change and walks the pipeline as it does today. A small card, or a large one whose parts cannot run separately without thrashing the same files, must not split.

Who creates the children: **the agent on the parent**, when that test passes. A person can still file cards by hand; that is already possible. The missing capability is the agent's.

This takes the working parent from option 1 and the spawn-the-parts behaviour from option 2. It rejects option 3 (do not model this) and rejects a parent that cannot itself do work.

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

A card that is one change should behave exactly as it does today. A card that is several changes should be able to become a group of cards, each still one change.

Concretely:

- An agent can create **real cards** in the same project, each associated with the card it is working, not only a list in a write-up.
- It does so only after judging the work large **and** worth dividing. Efficiency is the bar: parallel sandboxes, smaller context, or a pipeline that can finish parts independently. "It would be tidy to outline sub-tasks" is not enough.
- Those parts are **linked** to the parent, so the board can show the group and a reviewer can open the parent and see the children.
- Each part keeps today's invariant: **one card, one branch, one sandbox, one agent**. The large task is a relationship between cards, not a second kind of sandbox.
- The parent remains a working card. It keeps its branch and its pipeline. Spawning does not turn it into a folder.
- Somebody looking at the parent can tell whether parts were created, whether they are moving, and whether any have failed, without opening each child.
- Hosted spend still makes sense: hours belong to the card that ran them; a group total is a sum. Splitting must not become a way around the 24-hour card ceiling or the team allowance.

The change should not try to become an agent operating system. Tracking every worktree, validating a combined diff, scheduling children in dependency order, and merging N pull requests as one are follow-on problems. They are only worth building after a group of cards has existed long enough for someone to say which of those they actually missed.

## Feature ideas

Chosen: **B, on a working parent (1), with an efficiency gate.** Association plus an agent that *may* spawn. Not A (people only), not C (a container that cannot work), not D (do not model this).

The options as considered:

- **A. Linked cards, people only.** Cheap, and does not give the first agent a way to act.
- **B. Agents may create cards.** A tool on the running card, parent set to that card. The risk is a chatty agent; the efficiency test is what refuses that.
- **C. Parent as container.** A new kind of object. Rejected: the parent stays a card.
- **D. Do not build a model.** Rejected: the split should happen in Bento when it is worth it.

## How anybody would know it worked

Not "we shipped parent ids." These are the checks that would make the feature real:

1. A person can open a parent and see its children, their stages, and whether any agent is running, without hunting the board.
2. When an agent splits, the parts exist as rows that later stages can pick up independently, not as headings in a markdown file.
3. A card whose work is one change, or whose parts cannot be divided without fighting over the same branch, finishes with **zero** children. An agent that always splits has failed the efficiency test.
4. A card that did split does not carry the children's scope into implementation on its own branch. What remains on the parent is only work the agent kept for itself, if any.
5. Deleting or finishing the parent has a defined effect on children (keep them, cancel them, or refuse) and that effect is visible before it happens.
6. Spend on the group equals the sum of spend on the cards. A child has its own 24-hour clock. The team allowance still sums every card.
7. A team that only files small cards sees no new ceremony.

If we cannot describe a card that would fail those checks, we are not ready to build.

## What this is deliberately leaving out

- Dependency graphs, blockers, and "child B starts when child A is done."
- Sharing or stacking worktrees across cards. Each child is a normal card.
- Combining child pull requests into one, or merging in a parent-defined order.
- A dedicated container object, a new pipeline type, or a second board. The parent is a card.
- Orchestration UI for deep trees. The spawn rule can apply to any card (a child may split if it too is large and worth dividing); the first version only has to show a parent and its direct children.
- Automatic re-aggregation of child write-ups into a parent verdict.
- Changing Linear's importer to round-trip parent/child. Worth doing later if we have a parent in Bento; not a reason to invent one.
- Billing policy changes. The 24-hour card ceiling stays a loop guard. Splitting work must not become a way around a team allowance; the team allowance already sums every card.
- Parallel agents on one card. A split creates other cards; it does not lift "one agent at a time" on the parent.

## When not to build this

The evidence **does not** support building a coordinator that watches every worktree and validates combined output as a first feature. That is several products stacked on a relationship we have never shown a user.

The evidence **does** support the hole the decision above fills: the first stage is asked to generate feature ideas, and the product has no type for more than one idea. Building association plus a guarded spawn is in scope. Building "always decompose" is not: that would fail the efficiency test on most cards.

## Still open

After an agent spawns children, the parent's own pipeline still needs a rule. Design cannot invent this quietly.

**What does the parent do once it has split?**

- **Keep going.** It finishes this stage and may keep work of its own (a leftover slice, or the investigation write-up only). Children run as their own cards.
- **Hold.** It stays in this stage until the children are done, then continues.
- **Stop implementing.** Spawning is the work of this stage; later stages on the parent are skipped or the parent is marked done.

The decision above (a working card that *may* spawn) is compatible with the first of these and in tension with the third. The second is a new gate we do not have. I am not picking one here.
