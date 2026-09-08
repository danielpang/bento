# Edit agent from board — UI/UX design

## What this covers

The board already names the agent that runs each stage. This turns that
name from a label into a control: click it to switch the agent for that
stage, or to open the agent's own settings, without leaving the board.

No prior investigation file existed (`docs/bento/product-investigation.md`
is absent), so this design was written against the code directly.

### Which surface: the web console board

"Web TUI" maps to two Kanban boards in this repo. This design targets the
**web console** (`apps/web`), because that is the surface that matches the
request literally: its stage lane header renders the agent's **name**
(`Board.tsx:615-629`, the `.lane-agent` pill), and clicking is native.
The terminal TUI's Kanban view shows no agent at all, and its list view
shows the tool id (`[claude-code]`), not the name. A short parity note for
the terminal is at the end.

### What "edit the agent" means here

A stage points at an agent profile through `defaultAgentProfileId`; the
profile carries the tool and model. So "editing the agent on a stage" has
two honest meanings, and the design serves both from one place:

1. **Switch which agent runs the stage** (the common, quick action):
   `PATCH /api/stages/:id` with a new `defaultAgentProfileId`. This reuses
   the exact mutation the pipeline editor already calls
   (`client.updateStage`, `StageConfig.tsx`), so no new endpoint is added.
2. **Edit that agent's own configuration** (model, skill, name): a link
   into the existing Agents panel editor (`AgentsPanel.startEdit`).

## The control

The `.lane-agent` pill (assigned) and the `.lane-agent-empty` pill
("no agent assigned") become a Radix dropdown-menu **trigger**, following
the pattern already established by the project switcher
(`ProjectPicker.tsx`, the `picker-*` classes). Backlog and Completed
carry no agent, so they keep their plain, non-interactive label.

- **Resting:** unchanged pill, plus a small caret so it reads as
  openable. Tooltip stays `{cli} · {model}`.
- **Hover / focus:** border brightens to `--field-line`, cursor pointer.
  `aria-label` carries the action, e.g. "Change the agent for the
  UI/UX design stage" (assigned) or "Assign an agent to the
  Implementation stage" (empty).
- **Open:** border takes the brand color; the menu anchors under the
  pill (Radix portal, `align="start"`, `sideOffset={6}`).

Because it is a real button inside a Radix menu, keyboard support comes
for free and matches the rest of the app: Enter/Space opens, arrows move,
typeahead jumps to a name, Enter selects, Escape closes, focus returns to
the pill.

## The popover

Mirrors `.picker-menu`. Top to bottom:

- A mono kicker naming the stage: **Runs UI/UX design**.
- A radio group of the org's agent profiles. Each row: provider mark
  (`ProviderMark`), the profile **name**, and a dim mono sub-line
  `{cli} · {model}`. The current agent is ticked (✓) and bold.
- **No agent (start runs by hand)** — copy verbatim from the existing
  stage editor, ticked when the stage has none.
- A separator, then two action rows:
  - **Edit this agent's settings** (shown only when one is assigned) —
    opens the Agents panel with that profile's editor open.
  - **Add a new agent** — opens the Agents panel's create form.
- A quiet footnote: **Applies to the next run. A card already running
  keeps its agent.** (Same promise the pipeline editor makes with
  "Cards already in the stage keep going.")

Selecting a profile is the whole edit: no confirm step, consistent with
drag-to-move and one-click approve on the board.

## States

**Populated (default).** As above. This is the common case.

**No agent on this stage.** The dashed "no agent assigned" pill is itself
the trigger; opening it shows the list with "No agent" ticked, so
assigning one is the same gesture as changing one.

**No agents exist in the org (fresh install).** The menu body reads
**No agents yet. Create one to run this stage.** followed by the single
useful action, **Add a new agent**. No empty radio list.

**Loading.** The board loads stages and profiles together before it
renders (`App.refresh`), so the pill and its list are populated when
shown. The trigger is disabled until that first load resolves.

**Saving.** On selection the menu closes and the pill optimistically
shows the chosen agent, dimmed with a small spinner in place of the
caret, until the live board stream confirms the change. The board already
updates from `/api/board/:id/events`, so success needs no toast.

**Error (save failed).** The pill reverts to the previous agent and a
toast explains: **Could not change the agent for {stage}. Try again.**
Reopening the pill retries. This is the app's existing `toast.fail`
convention.

**Permission denied / access lost.** Every member of an organization can
already edit that org's stages, so the control is shown to anyone who can
see the board; there is no per-role gate to add. The one denial is losing
access: if you were removed from the org or the project was deleted, the
`PATCH` returns 404 (the route access check) and the board refreshes with
the toast **This project is no longer available.** The failure leaks no
agent id, model, or stage state. If the team later restricts pipeline
edits by role, the pill falls back to its current read-only label with
the tooltip **Only owners can change stage agents**; that gate does not
exist today, so this design does not build it.

## Copy (exact strings)

- Trigger aria-label (assigned): `Change the agent for the {stage} stage`
- Trigger aria-label (empty): `Assign an agent to the {stage} stage`
- Menu kicker: `Runs {stage}`
- No-agent row: `No agent (start runs by hand)`
- Action: `Edit this agent's settings`
- Action: `Add a new agent`
- Footnote: `Applies to the next run. A card already running keeps its agent.`
- Empty (no profiles): `No agents yet. Create one to run this stage.`
- Error toast: `Could not change the agent for {stage}. Try again.`
- Access-lost toast: `This project is no longer available.`

All copy avoids em and en dashes and hyphen-as-pause, per the house style.

## Consistency and scope notes

- Reuses `PATCH /api/stages/:id` / `client.updateStage`; no new server
  route, so no new entry in the `auth.e2e.test.ts` route matrix is needed.
- The interaction reuses an existing, generally available capability
  (changing a stage's agent already ships in the pipeline editor), so it
  need not sit behind the `beta-testers` flag. If the team prefers to
  stage the rollout, wrapping the trigger in `<BetaOnly>` is the only
  change required.
- No visual security surface changes: this renders profile names and tool
  ids the console already shows.

## Terminal parity (follow-up, not this card)

To keep the terminal TUI in step (the docs treat web and terminal as
peers): show the agent on the Kanban lane header in `apps/tui`, make it a
mouse target that opens the existing **assign** screen
(`go({ name: "assign", stageId })`, `Setup.tsx`), and add a key on the
focused lane for the same. The assign screen already lists profiles and
"No agent (start runs by hand)" and saves through the same
`client.updateStage`. This is a separate change on a separate surface and
is out of scope for this card.

## Artifact

An annotated, self-contained mockup of every state above is at
`/workspace/artifacts/edit-agent-from-board.html` (dark theme, real
console tokens). It is not committed, per the artifact convention.
