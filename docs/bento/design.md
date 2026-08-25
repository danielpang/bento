# UI/UX design: DeepSeek Harness in Bento

Stage: UI/UX design. Works from
[product-investigation.md](./product-investigation.md).

The investigation recommends not shipping a headless `dsh` adapter yet,
and lists six open decisions. This design does not pretend those
decisions are made. It splits the work into two parts that ship
independently, and it designs Part 2 in full so that whichever approach
is chosen (B now, C or D later), the screens are already specified and
the honest copy is already written.

- **Part 1, DeepSeek today.** No upstream dependency, no adapter. Makes
  DeepSeek a first class provider for the tools Bento already runs.
- **Part 2, DeepSeek Harness as a tool.** The `dsh` agent itself, once
  an adapter exists.

---

## The design problem, in one line

Every other agent in Bento streams its work onto the card. Headless
`dsh` prints one final message when it exits and nothing before it.

A card that shows the usual "Waiting for output..." for twenty minutes
reads as a stall, so people will press Stop on runs that were fine. The
whole of Part 2 turns on saying that out loud, at the moment the tool is
chosen and again while the run is quiet, rather than letting a person
discover it from an empty pane.

Corollary: the capability differences between tools are currently
learned by running one. This design surfaces them in the picker for
**every** tool, not just `dsh`. That is the reusable part of the work.

---

## Part 1: DeepSeek today

### Screen: Agents, New agent (Tool = pi or opencode)

Today the Provider row for pi and opencode offers Anthropic, OpenAI,
Google, OpenRouter, and "Type it myself". DeepSeek models are reachable
only as `openrouter/deepseek/deepseek-v4-pro`, which bills OpenRouter
and is not discoverable by anyone typing "deepseek".

**Change.** Add a native `deepseek` provider to the manual catalog with
its logo and `DEEPSEEK_API_KEY`, and add it to `BY_CLI` for pi and
opencode. The provider chip row becomes:

> Anthropic · OpenAI · Google · DeepSeek · OpenRouter · Type it myself

Picking DeepSeek fills Model with `deepseek/deepseek-v4-pro`. The Model
select lists what the catalog carries:

> DeepSeek V4 Pro (deepseek-v4-pro) · DeepSeek V4 Flash
> (deepseek-v4-flash) · DeepSeek V3.2 (deepseek-v3.2) · DeepSeek R1
> (deepseek-r1)

The existing format line under the field is unchanged and already
correct: "provider/model, optionally with :thinking. Prefix with
openrouter/ for OpenRouter."

**Empty and unknown states.** Unchanged from the current form: the
install probe stays quiet when it cannot answer, and "Type it myself"
remains for ids the snapshot has not caught up with.

### Screen: Agents, Model provider keys

Add a seventh tab.

> ● Anthropic  ● OpenAI  ● OpenRouter  ● Cursor  ○ Gemini  ● Poolside  ○ DeepSeek

Tab contents, following the existing card exactly:

- **API key** heading, "Not set." or "Saved sk-...9f2", SecretField with
  placeholder "Paste the key", button "Save" or "Replace".
- Help line: "Used by pi and opencode when running DeepSeek models
  against DeepSeek's own API, and by DeepSeek Harness. Create one in the
  DeepSeek platform console."
- **Base URL (optional)** heading, "Not set: requests go to the provider
  directly.", placeholder `https://api.deepseek.com`.
- Help line: "Point DeepSeek somewhere else, for example a gateway of
  your own. Leave it empty for DeepSeek's own API."

Remove confirm reuses the shared dialog: title "Remove
DEEPSEEK_API_KEY?", body "Saved values are never shown again, so you
would need to paste it fresh. Agents on this provider stop running until
one is here.", button "Remove".

### Documentation

`docs/agents.md` gains a paragraph under the provider notes:

> **DeepSeek models.** Available today through pi or opencode. Save
> `DEEPSEEK_API_KEY` and choose the DeepSeek provider for a native key
> and a native bill, or keep using `openrouter/deepseek/...` if you
> would rather bill OpenRouter. DeepSeek Harness (`dsh`), the agent
> runtime, is a separate thing and is not a tool Bento can run yet. See
> [the investigation](./bento/product-investigation.md) for why.

That paragraph is the answer to the Slack thread, and it ships in Part 1
whether or not Part 2 is ever built.

---

## Part 2: DeepSeek Harness as a tool

Identity, so every surface agrees:

| Thing | Value |
| --- | --- |
| Label shown to people | **DeepSeek Harness** |
| CLI id | `dsh` |
| Binary probed in the sandbox | `dsh` |
| Default model | `deepseek-v4-pro` |
| Model format | A bare model id |
| Providers offered | DeepSeek only, plus "Type it myself" |
| Credential | `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL` |
| Live messaging | None: absent from `LIVE_TOOLS` |
| Session continuity | None: `FORGETS_BETWEEN_RUNS.dsh = true` |
| Live transcript | None: new `NO_LIVE_TRANSCRIPT` set |
| Reports cost | No |

`NO_LIVE_TRANSCRIPT` is the one new primitive this design asks for. It
is a set of CLI ids, it lives beside `LIVE_TOOLS` and
`FORGETS_BETWEEN_RUNS` in `apps/web/src/components/ui.ts`, and it drives
two things: the capability line in the picker and the quiet run state on
the card. Deriving both from one flag is what keeps the promise made in
the picker identical to the behaviour on the card.

### Screen: Agents, New agent, Tool field

The select gains one option, listed last so the working tools stay
first:

> Claude Code · Codex CLI · Cursor CLI · opencode · pi · Poolside (pool)
> · **DeepSeek Harness (preview)**

Directly under the select, a new line that appears for **every** tool.
Three clauses, always in the same order: live output, messaging, cost.

| Tool | Capability line |
| --- | --- |
| Claude Code | Streams as it works. Messages queue behind the current step, in the same conversation. Reports what a run cost. |
| pi | Streams as it works. Messages steer it while it works. Reports what a run cost. |
| Codex CLI | Streams as it works. Messages are delivered when the run ends, resuming the same session. Cost is not reported. |
| Cursor CLI | Streams as it works. Messages are delivered when the run ends, resuming the same session. Cost is not reported. |
| opencode | Streams as it works. Messages are delivered when the run ends, resuming the same session. Cost is not reported. |
| Poolside (pool) | Streams as it works. Messages are delivered when the run ends, as a new run. Cost is not reported. |
| DeepSeek Harness | Prints nothing until the run ends. Messages are delivered when the run ends, as a new run. Cost is not reported. |

Rendered as `.muted`, so it reads as guidance rather than a problem.

Below it, only when `dsh` is selected, a `.warn` block:

> **Developer preview.** DeepSeek Harness is not finished, and its own
> project says its interfaces will change without warning. Two limits
> are worth knowing before you assign it to a stage. It prints nothing
> while it works, so the card stays quiet until the run ends. It cannot
> continue a previous conversation, so each message on a card starts a
> fresh run with a compacted transcript.

No modal, no "I understand" checkbox. The warning sits in the same slot
as the existing "not installed" warning, which is the slot people
already read before pressing Add agent.

**Not installed state.** Existing pattern, existing component:

> DeepSeek Harness is not installed where agents run here. Install it,
> then this agent can start: installation guide
> `npm install -g @deepseek-ai/dsh`

**Unknown install state.** The probe costs a container and can fail. It
already returns `installed: null` in that case and the warning stays
hidden. That stays true here: an unanswerable probe must not accuse a
tool that is probably fine.

**Provider and Model.** One chip, the same shape `pool` already uses:

> DeepSeek · Type it myself

Model select: `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v3.2`.
Format line under the field:

> A model id DeepSeek Harness can reach. Its own profile can be pointed
> at other providers, which Bento does not configure. Route DeepSeek
> models through OpenRouter instead by choosing pi or opencode.

**Name and Skill** are unchanged.

**Validation.** The Add agent button stays disabled until Name and Model
are filled, as today. `checkAgentPairing("dsh", model)` must reject
prefixed strings, since the tool takes a bare id:

> DeepSeek Harness takes a bare model id, so `deepseek/deepseek-v4-pro`
> will not start. Use `deepseek-v4-pro`.

### Screen: Agents, Your agents list

The row gains a badge after the name, and only there:

> [DeepSeek mark] **Reviewer**  `preview`
> dsh · deepseek-v4-pro
> Edit   Remove

The badge repeats on the Pipeline panel's stage row, so somebody
reviewing a pipeline can see which stages depend on a preview tool
without opening Agents.

It deliberately does **not** appear on board cards. The board answers
"what is happening to this work", and a permanent tool caveat on every
card in a lane would compete with the state colours that lane depends
on.

**Provider mark.** `ProviderMark` renders nothing when the provider has
no logo, so the DeepSeek entry in the manual catalog must carry one.
Without it the row loses the fastest read it has: which company is about
to be billed.

### Screen: A card running DeepSeek Harness

Five states, in the order a person meets them.

**1. Queued.** Unchanged. The run row shows the agent name and the
queued time.

**2. Working, no live transcript.** This replaces the generic "Waiting
for output..." for tools in `NO_LIVE_TRANSCRIPT`. The orb keeps turning,
because the run genuinely is alive; what changes is the text beside it.

> **No live output from this tool**
>
> DeepSeek Harness prints one final message when the run ends and
> nothing before it, so this card stays quiet until then. That is the
> tool, not a stall. The work still lands on the branch, and Stop ends
> the run now.
>
> Working for 4m 12s.

The elapsed line is the only moving part, and it is the thing that
answers "is anything happening at all" when nothing else can.

**3. Working for a long time.** After 30 minutes with no exit, the block
above gains a `.warn` line. This state exists only for this class of
tool: for every other agent, a long silence is visible as a long gap
between streamed events, and here it is invisible.

> Still working after 30 minutes, with nothing printed. Nothing on this
> card can tell whether it is progressing, because the tool prints
> nothing until it ends. Stop it if this looks wrong.

**4. Finished.** The final message arrives as one assistant bubble,
preceded by a system note so the shape of the transcript is explained
rather than looking truncated:

> DeepSeek Harness printed its final message. There are no tool steps or
> thinking to show, because this tool does not print them while it works.

Because the transcript is thin, **Files changed** is the real read on a
`dsh` run. It is already on the card and needs no new design; it simply
becomes the primary evidence rather than a supplement, which is worth
saying in the docs.

**5. Composer.** The existing between-runs sentence for tools that
forget is already correct and needs no new copy:

> Nothing is running. Your message starts a new run on this card, with a
> compacted transcript of this conversation.

And while a run is active:

> This tool takes messages between runs: yours is delivered the moment
> the current run ends, as a new run with a compacted transcript of this
> conversation.

The queued bubble keeps its existing speaker line, "you · queued until
the agent finishes".

### Failure states

Every one of these is written to name the door the reader can actually
open, in the wording the existing failures use.

| What happened | What the card says |
| --- | --- |
| No key saved, hosted | No DEEPSEEK_API_KEY is configured, so DeepSeek Harness cannot start. Add it under Team, then run again. |
| No key saved, local | No DEEPSEEK_API_KEY is configured, so DeepSeek Harness cannot start. Save it with bento setup in a terminal, then run again. |
| Key rejected | DeepSeek rejected the saved key. Replace DEEPSEEK_API_KEY under Model provider keys, then run again. Keys revoked in the DeepSeek console fail this way. |
| Model unavailable | DeepSeek Harness could not run the model deepseek-v4-pro. Change the model on this agent under Agents, then run again. |
| Binary missing | dsh is not installed in this sandbox, so the agent never started. Its install did not finish, and the next run installs it again. If it keeps failing, the sandbox cannot reach that CLI's installer. |
| Node too old | DeepSeek Harness needs Node 22.19 or newer, and this sandbox has an older one, so it never started. A rebuilt sandbox installs the right one. |
| Profile bootstrap failed | DeepSeek Harness could not create its profile directory, so it never started. This is usually a read only home directory in the sandbox. |
| Output unreadable | DeepSeek Harness finished, but Bento could not read what it printed. This tool is a developer preview and changes its output without notice, so a Bento that predates the change reads nothing. Update Bento, and report it if you are already current. |
| Card already busy | Existing 409 and CARD_BUSY handling, unchanged. One card, one agent. |

The local mode wording drops the login sharing sentence the other tools
carry. There is no `dsh` login on anybody's machine to share, so
offering it would point at a switch that cannot help.

### Permission denied

Two different readers, two different answers.

**A member who is not an owner or admin.** The credential routes answer
403 for them today, but the console still renders the field and the Save
button, so the only way to learn is to paste a key and watch a toast.

Design: members see the tabs and the dots, so they can tell whether a
key is set, and the field is replaced by one line.

> Only owners and admins can change credentials. Ask an owner to save
> the DeepSeek key.

The dots stay because "is it set" is exactly what a member needs to know
before asking somebody, and the value was never readable anyway.

**Somebody else's card.** Unchanged and deliberately indistinguishable
from a deleted one: the route answers 404 either way, and the console
shows its existing "this card is gone" state. Nothing in this feature
adds an entity route, so the auth matrix in `auth.e2e.test.ts` gains no
new row. The only route surface that changes is the credential name enum
on the existing secrets route.

### Loading and empty states

| Surface | Loading | Empty |
| --- | --- | --- |
| Model provider keys | Existing three row skeleton | "Not set." per field, with the help line below |
| Keys failed to load | Not applicable | "Could not load saved keys, so this cannot show which are set. Retry once the server is reachable." |
| Tool install probe | Silent while unanswered | Silent when unanswerable, so no tool is accused wrongly |
| Your agents | Existing | "None yet." |
| A card with no runs | Existing | Existing |

### Spend

`reportsCost("dsh")` is false, so DeepSeek Harness joins the silent list
automatically and every spend figure in the console starts saying so
without a line of copy being written. That is the intended behaviour of
`spendCoverageNote()` and the reason not to special case it.

### Documentation row

`docs/agents.md` gains a row in the comparison table:

| Tool | Model format | Credential | Talk to a working agent | Reports cost |
| --- | --- | --- | --- | --- |
| DeepSeek Harness (dsh) | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` | Between runs: delivered when the run ends, as a new run | No |

And a per tool section stating the preview status, the quiet card, the
lack of resume, and that Files changed is the read on a run.

---

## What this design deliberately leaves out

- **A progress fake.** A spinner with invented step names, or a periodic
  "still working" poll dressed as agent output, would be the easy fix
  and would be a lie. The elapsed timer is the most this design will
  claim, because it is the most that is true.
- **A preview interstitial.** A modal gate before adding a preview agent
  gets clicked through and teaches nothing. The inline warning sits
  where the install warning already sits.
- **A DeepSeek Harness provider matrix.** The harness can be pointed at
  Anthropic, OpenAI and others through its own profile. Bento offers one
  key and one base URL, and says so in the model field. Widening this is
  decision 5 in the investigation and needs no new screen when it lands:
  it is more chips in a row that already exists.
- **Anything touching `dsh web`.** Out of scope in the investigation and
  out of scope here.

## Decisions this design assumes

Stated so they can be overturned cheaply. Each one is a line of copy or
a flag, not a screen.

1. The label is "DeepSeek Harness", not "dsh". The CLI id shows only in
   the agent row's second line, where every tool shows it.
2. Preview status is admitted in the picker, the agent row, and the
   stage row. It is not admitted on board cards.
3. `dsh` is a DeepSeek only tool in v1, the way `pool` is a Poolside
   only tool.
4. Part 1 ships regardless of what happens to Part 2.

## If the approach changes

Approach C or D, from the investigation, gives `dsh` a real event
stream. When that lands, the design shrinks rather than changes: remove
`dsh` from `NO_LIVE_TRANSCRIPT`, and the quiet run state, the picker's
first clause, and the finished note all disappear on their own. If
session ids arrive too, clear `FORGETS_BETWEEN_RUNS.dsh` and the
composer's copy corrects itself. Nothing in Part 2 has to be redrawn to
absorb a better upstream.

## Mockups

Not committed, shown on the card, under `/workspace/artifacts`:

- `deepseek-harness-ui.html`, the screens and states above, in the
  console's own palette.
- `deepseek-harness-run-states.mmd`, the run state machine including the
  quiet and long silence states.
