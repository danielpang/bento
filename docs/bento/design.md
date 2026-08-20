# Design: pool agent and Poolside models on the board

**Feature:** Create a task to add pool agent and pool's models to the board
**Source:** [Slack thread](https://slack.com/archives/C0BG95ZSDE3/p1787202839914569)
**Stage:** UI/UX design
**Date:** 2026-08-20
**Reads from:** `docs/bento/product-investigation.md`

Artifacts for review (not committed): `pool-agent-design.html` (every screen
and state, drawn in the product's own palette) and `pool-agent-states.mmd`
(the state graph).

## What this design is, in one line

Poolside becomes the sixth entry in a list that already exists in six places,
and the design work is almost entirely in the states around it: a tool that is
not installed yet, a key nobody has saved, a member who cannot save one, and
four ways a run can fail. Nothing here invents a new surface.

## Principle: no new surfaces

Every other supported CLI is reachable through the same three screens, and a
person who has added a Cursor agent should be able to add a pool agent without
learning anything. So:

- No Poolside section in the Agents panel. It is a row in the Tool select and a
  chip in the Provider row.
- No Poolside card in settings. It is a tab beside Cursor and Gemini.
- No new card affordance on the board. A pool agent is an agent.
- No migration prompt for teams already running Laguna through OpenRouter on pi
  or opencode. That path keeps working and is not second class, so a banner
  telling people to switch would be Bento having an opinion it has not earned.

The one thing that is genuinely new is copy: a credential's help text, a model
field's format line, and two run failures that have no equivalent today.

## Screen 1: Agents panel, New agent modal

Reached from **New agent** in the Agents drawer header, or **Edit** on an
existing agent. The modal already cascades tool to provider to model; Poolside
slots into that cascade.

**Tool.** A new option reading `Poolside (pool)`, placed after `pi` and before
`Fake agent (for testing)`, which is where the catalog order puts it. The label
carries the binary in parentheses because "Poolside" alone is the company and
the person choosing is choosing a CLI. This matches nothing else in the list
today (`Claude Code`, `Codex CLI`, `Cursor CLI`, `opencode`, `pi`), so the
alternative is a bare `Poolside`. Recommendation: `Poolside (pool)` for one
release, because the CLI's name is the thing people will search the list for.

**Provider.** Selecting the tool preselects a single Poolside chip, plus the
existing **Type it myself** escape hatch. One chip looks odd next to Cursor's
five, and it is still worth drawing: the chip is what makes the model field a
picker rather than a text box, and the row is where a person learns this tool
reaches one provider.

**Model.** A select of Laguna models, defaulting to the catalog default.
Underneath:

> A model id served by Poolside Platform. Route through OpenRouter instead by
> choosing pi or opencode as the tool.

That second sentence is the only place in the product that tells someone the
workaround exists, and it belongs here because this is where they are deciding.

**Name** and **Skill** are unchanged.

### States in this modal

| State | What a person sees |
|---|---|
| Default | Poolside chip selected, default model chosen, **Add agent** enabled once a name is typed |
| Pairing ok | `Runs on Poolside.` in muted text |
| Pairing impossible (typed a Claude id) | `This tool cannot run Anthropic models. It reaches Poolside.` in the error colour, **Add agent** disabled |
| Pairing unknown (typed an id the catalog lacks) | `This model is not in the catalog, so its provider could not be checked.` and the agent still saves |
| Tool not installed, local mode | `Poolside is not installed where agents run here. Install it, then this agent can start:` with a link and `curl -fsSL https://downloads.poolside.ai/pool/install.sh \| sh` |
| Tool new, hosted mode | `Poolside is new here. Sandboxes created before it shipped install it on their next run, which adds a few minutes the first time. Nothing to do: if the install fails, the run says so and the run after it tries again.` |
| No key saved | `No Poolside key is saved. This agent will refuse to start until one is saved under Model provider keys.` |
| Tool availability unknown | Nothing. An unanswerable probe stays quiet, as it does today |

Two of these need explaining.

**The hosted warning is new, and it exists because the sprite driver lies by
construction.** `SpriteDriver.checkTools` answers from the static
`AGENT_BINARIES` list rather than by inspecting a machine, so the moment `pool`
joins that list every sprite reports it installed, warm machines that predate
the toolchain bump included. The investigation flags this as the launch risk.
The form cannot detect it, so it should not claim certainty in either
direction: it says the first run may be slow and that a failed install retries,
which is true whether the sandbox is warm or cold.

**The missing-key warning is new for every provider, not just Poolside.** Today
a person can add an agent for a provider with no saved key and learn about it
when a run fails minutes later. The Agents panel already fetches the secret
list (it reads `CLAUDE_CODE_OAUTH_TOKEN` from it), so the check costs nothing.
Adding it as part of this feature is a small widening of scope; call it out at
implementation planning and drop it if the team wants Poolside kept to one
diff. If it is dropped, the "no key" case is caught only by the run failure in
Screen 4.

## Screen 2: Agents list and the board

A pool agent lists as `pool · laguna-s-2.1` under its name, from the same
template as every other agent. The provider mark to its left is the one open
visual question.

`ProviderMark` draws `provider.logo`, a data URI held in the catalog. There is
no Poolside mark in the repository, and inventing a brand mark is not something
a design stage should do. Two acceptable answers:

1. **Ship no mark.** `ProviderMark` renders nothing when `logo` is empty, which
   is already the fake agent's behaviour, and the row stays legible. The Mac
   app already draws nothing for Cursor for the same reason.
2. **Ship a neutral placeholder** and replace it when a licensed mark arrives.
   The mockup draws one: a ripple over a disc, monochrome, so `--logo-filter`
   handles both themes.

Recommendation: ship no mark, and open a follow-up to add the real one. A
placeholder that resembles a brand is worse than an empty slot, and the empty
slot has precedent.

Nothing else on the board changes. The card shows the agent's name, not its
tool.

## Screen 3: Model provider keys, Poolside tab

A sixth tab, last in the row, dot lit when `POOLSIDE_API_KEY` is saved. The row
already scrolls horizontally on narrow screens, which is why a sixth tab does
not need a layout change.

**Field:** one API key. **Help:**

> Used by the Poolside CLI, whichever Laguna model it runs. Create one in the
> Poolside console under API keys, or run `pool login` in a terminal and copy
> the key it stores.

The second sentence matters more than it looks: someone who has only ever run
`pool login` has never seen their key as a string and will otherwise go looking
for a console page they have never opened.

**Enterprise deployments are out of v1.** The investigation left this open
(decision 4). This design assumes Poolside Platform only, so the tab holds one
field and no base URL. If enterprise is pulled in later, it takes a second
field on the same tab, labelled `Base URL (optional)` with `Not set: requests
go to Poolside Platform.`, exactly as Anthropic and OpenAI do it. That is a
field, not a redesign, so deferring costs nothing.

### States on this tab

| State | What a person sees |
|---|---|
| Loading | Tab dots grey, field not yet offered |
| Not set | `Not set.` and an empty field with **Save** |
| Saved | `Saved ps-live-...8f21` with **Remove**, and the field's button reads **Replace** |
| Load failed | `Could not load saved keys, so this cannot show which are set. Retry once the server is reachable.` Saving stays available |
| Removing | Existing confirm dialog: `Remove POOLSIDE_API_KEY?` / `Saved values are never shown again, so you would need to paste it fresh. Agents on this provider stop running until one is here.` |
| Member, not owner or admin | Whether a key is saved, and no controls |

### The permission-denied state, which does not exist today

`POST /secrets` and `DELETE /secrets/:id` answer 403 with `only organization
owners and admins can manage credentials`, and the card offers every member the
field anyway. A member pastes a key, waits, and gets a toast of a server
sentence.

The Poolside tab should not ship that, and the fix is one card for every tab:
when the caller is a member, replace the field with the state and a pointer.

> Saved by an owner or admin.
> Only owners and admins can add or remove credentials. Ask one of them if a
> Poolside run says no key is configured.

and when nothing is saved:

> Not set.
> Only owners and admins can add or remove credentials. Ask one of them to save
> a Poolside key, or your runs on this provider will not start.

Members keep seeing whether the key exists, because that is the fact that
explains their failing runs. This needs the caller's role on the client;
`TeamSettings` already reads roles, so the data is reachable.

## Screen 4: the card conversation, and failures

**pool takes messages between runs.** `pool exec` is a batch invocation with no
open stdin conversation, so pool is absent from `LIVE_TOOLS` and the composer
shows the sentence that already exists:

> This tool takes messages between runs: yours is delivered the moment the
> current run ends.

When nothing is running, the existing line stands: `Nothing is running. Your
message starts a new run on this card, continuing the same conversation.` That
promise is kept by `pool exec --continue`. If the CLI turns out not to carry
history across invocations, this sentence is what has to change, and the design
would then read `Nothing is running. Your message starts a new run on this
card.` Flag it as a design decision that depends on an engineering unknown the
investigation already listed.

### Four failures, two of them new copy

| Cause | Transcript |
|---|---|
| No credential | `No POOLSIDE_API_KEY is configured, so pool cannot start. Add it under Team, then run again.` (hosted) or the local variant. Generated from the missing variable; no new code |
| Binary missing | `pool is not installed in this sandbox, so the agent never started. Its install did not finish, and the next run installs it again. If it keeps failing, the sandbox cannot reach that CLI's installer.` Already written, already right |
| Platform rejects the model | **New.** `pool rejected the model laguna-xl-9. Poolside answered: unknown model. Change the model on this agent under Agents, then run again.` |
| Platform rejects the key | **New.** `Poolside rejected the saved key. Replace POOLSIDE_API_KEY under Model provider keys, then run again. Keys revoked in the Poolside console fail this way.` |

The last two are distinct on purpose. "No key configured" and "the key you
configured is refused" have different fixes, and a single auth error hides the
one where everything looks correctly set up.

**Spend.** pool reports no cost, so it belongs on the silent side of
`reportsCost`. The sentence that accompanies every spend figure is generated
from the catalog, so it rewrites itself: no copy to edit, and no chance of a
total that quietly counts pool runs as free.

## Screen 5: terminal setup

`bento setup` reads the same catalog, so the tool list grows one row:
`Poolside` with binary `pool`. Because Poolside reaches exactly one provider,
the provider screen shows a single option plus **Type a model id myself**, then
the model list. Header: `Poolside: which model?`. The credentials step gains
`POOLSIDE_API_KEY` in the same position it holds in the web tab row.

No new TUI screens, no new keys, no new hints.

## Empty states

There is no Poolside-specific empty state. The Agents panel's `None yet.` and
the board's existing empty lanes cover a team that has added nothing. Worth
saying explicitly, because "add an empty state" is the reflex and here it would
be a screen nobody reaches.

## Model list

The picker shows names with ids in parentheses, matching Cursor's rows:

- Laguna S 2.1
- Laguna XS 2.1
- Laguna XS 2.2
- Laguna M.1

**These ids are not settled.** The investigation lists the exact strings
Poolside Platform expects as an open unknown, and this design does not resolve
it: the layout, the copy, and every state above are identical whatever the
strings turn out to be. What the design does fix is the shape: name plus id,
newest first, no free-tier suffixes in this list (a `:free` variant is an
OpenRouter routing detail and does not belong under a native provider). If the
platform turns out to expose fewer than four, the picker shows fewer; a
one-model select is still a select.

## Accessibility and copy checks

- The provider chips are buttons with `aria-pressed`, as they are today.
- The tab dot is decorative; the tab's set state is also carried in text on the
  panel below it, so the green dot is never the only signal.
- Every warning colour used here is paired with words. Nothing is communicated
  by colour alone.
- No em dashes, en dashes, or hyphen-as-pause in any string above.
- Every message names the screen that fixes the problem, by the name that
  screen actually carries in the mode the reader is in (Team on hosted, Agents
  and `bento setup` locally).

## Open questions this design does not close

1. **Model ids** (from the investigation). Affects the list contents, not the
   design.
2. **Does `pool exec --continue` carry a session?** Decides whether the
   "continuing the same conversation" composer line is true for pool.
3. **Tool label:** `Poolside (pool)` or bare `Poolside`. Recommendation above.
4. **Provider mark:** empty slot or placeholder. Recommendation above.
5. **Scope of the member-facing credentials fix.** It is the right fix and it
   touches every provider tab. Worth its own diff if this one must stay small.

## What was deliberately not designed

- A Poolside onboarding flow or first-run tour. Adding an agent is three
  fields, and no other tool has one.
- Live steering UI for pool. Out of scope per the investigation, and the
  composer already has the correct sentence for tools without it.
- A prompt to migrate OpenRouter Laguna agents to native pool.
- Cost display changes. pool reports nothing, and the existing note already
  says the figure is a floor.
