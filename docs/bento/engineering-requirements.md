# Edit agent from board: engineering requirements

Turns the agent pill on each stage lane of the web console board into a
menu that switches the stage's agent, or jumps to that agent's editor.
Builds on `docs/bento/design.md`. This document is the plan an
implementer works from: which modules change, what data moves, and the
decisions with their reasons.

## What already exists, verified against the code

- **The mutation.** `PATCH /api/stages/:id`
  (`apps/server/src/routes/stages.ts:154`) accepts
  `defaultAgentProfileId: string | null`, resolves the stage through
  `getAccessibleStage`, answers 404 for foreign ids, and refuses a
  profile from another organization. It is already probed by the
  foreign-tenant matrix (`apps/server/src/auth.e2e.test.ts:850`). The
  client method is `client.updateStage`
  (`packages/api-client/src/client.ts:1342`). **No new endpoint, no
  matrix entry, no schema change, no migration.**
- **The data.** The board already receives `stages` (with
  `defaultAgentProfileId`) and `profiles` as props
  (`apps/web/src/App.tsx:1027`), loaded together in `App.refresh`
  before the board renders, so the menu never opens on missing data.
- **The pill.** `apps/web/src/components/Board.tsx:615` renders
  `.lane-agent` (assigned) or `.lane-agent-empty` ("no agent
  assigned"). Backlog and Completed pass no stage, so they keep the
  plain label for free.
- **The precedents.** `ProjectPicker.tsx` is the Radix dropdown-menu
  pattern (`picker-*` classes, portal, `data-portal-layer`);
  `AgentSession.tsx:1081` already reuses `picker-menu` for a second
  menu. `AgentsPanel.tsx` has `startEdit(profile)` and `openNew()`,
  currently internal to the component.
- **The promise in the footnote.** The orchestrator re-reads
  `defaultAgentProfileId` from the stage row when it starts a stage
  agent (`apps/server/src/orchestrator/stage-agent.ts:44`), and a
  running run carries its own `agentProfileId` on the run row. So
  "applies to the next run, a card already running keeps its agent" is
  true today with no orchestrator change.

## One correction to the design

The design's saving state waits for "the live board stream" to confirm
the change. No such signal exists: `routes/stages.ts` emits nothing,
and `BoardEvent` (`apps/server/src/events.ts:10`) only carries
feature and run events. Today, a stage edit made in the pipeline
editor reaches other open boards never, not eventually.

Decision, in two parts:

1. **The saving spinner resolves on the PATCH response**, which
   returns the updated stage. Waiting on a stream for a 200 the client
   already holds adds latency and a failure mode for nothing.
2. **The PATCH handler emits a new `stage_updated` board event**, so
   other viewers' lane headers repaint. This is safe for clients that
   shipped before the event existed: the web handler
   (`App.tsx:633-671`) routes any event it does not special-case into
   the coalesced 250 ms `refresh()`, and the TUI
   (`apps/tui/src/app.tsx:442`) schedules a refresh on every board
   event. No client change is required to consume it.

Scope note: stage create, delete, and reorder have the same staleness
and do not get the emit in this change. This card's control only
PATCHes, and each additional emit deserves its own verification.
Worth a small follow-up.

## Changes, module by module

### 1. `apps/server/src/events.ts`

Extend `BoardEvent` as a discriminated union rather than making
`featureId` optional, so existing emit sites keep their required
fields:

```ts
export type BoardEvent =
  | { type: "feature_updated" | "run_updated" | "run_output" | "feature_deleted";
      projectId: string; featureId: string; runId?: string; status?: string;
      currentStageId?: string | null; text?: string }
  | { type: "stage_updated"; projectId: string; stageId: string };
```

The bus, the pg-bus wire payload (`kind: "board"` travels inline as
JSON), and the SSE route (`apps/server/src/routes/runs.ts:431`)
forward events opaquely by `projectId`; none of them change.

### 2. `apps/server/src/routes/stages.ts`

In the PATCH handler, after the update returns a row, emit:

```ts
ctx.bus.emitBoardEvent({ type: "stage_updated", projectId: found.projectId, stageId: updated.id });
```

`found.projectId` is already in hand: `getAccessibleStage` selects it
(`apps/server/src/access.ts:101`).

### 3. New: `apps/web/src/components/LaneAgentMenu.tsx`

Its own file, like `ProjectPicker`, because `Board.tsx` is 884 lines
and the menu carries its own state. Props:

```ts
{
  stage: { id: string; name: string };
  agent: AgentProfile | undefined;      // resolved by Board, as today
  profiles: AgentProfile[];
  onAssign: (profileId: string | null) => Promise<void>;
  onEditAgent: (profileId: string) => void;
  onNewAgent: () => void;
}
```

Structure per the design: `Menu.Root` with the pill as `Menu.Trigger`
(a real button: keep the `.lane-agent` look, add a caret span and
button resets), portal content on `picker-menu` classes with a mono
kicker `Runs {stage}`, a `Menu.RadioGroup` of profiles (each row:
`ProviderMark`, name, dim `{cli} · {model}` sub-line, tick on the
current one), the `No agent (start runs by hand)` row (value ""),
separator, then `Edit this agent's settings` (only when assigned) and
`Add a new agent`, and the footnote `Applies to the next run. A card
already running keeps its agent.` Empty-profiles state per the design.
All copy exactly as the design's copy list; no em or en dashes.

Local state: `saving: boolean`. On select, close the menu, set
`saving`, `await onAssign(...)`, clear `saving` in `finally`. While
saving, the trigger is disabled and dimmed with the small spinner in
the caret's place. The optimistic name swap happens in App (below), so
the pill re-renders with the chosen agent immediately.

aria-labels: `Change the agent for the {stage} stage` /
`Assign an agent to the {stage} stage`.

### 4. `apps/web/src/components/Board.tsx`

- `BoardProps` gains `onAssignAgent(stageId, profileId | null):
  Promise<void>`, `onEditAgent(profileId)`, `onNewAgent()`.
- `Lane` gains an optional `agentMenu?: React.ReactNode` slot (or
  equivalently the stage id plus callbacks); stage lanes render
  `LaneAgentMenu` where the `.lane-agent` span is today, Backlog and
  Completed keep the plain spans at `Board.tsx:615-629`.

### 5. `apps/web/src/App.tsx`

- `onAssignAgent`: mirror `onMove`'s optimistic idiom
  (`App.tsx:1040`). Patch `stages` in place
  (`setStages(cur => cur.map(...))`), `await client.updateStage(stageId,
  { defaultAgentProfileId })`, then `refresh()` settles the truth. On
  failure: if the error reads as not found, toast
  `This project is no longer available.` and `loadProjectList()`;
  otherwise toast
  `Could not change the agent for {stage}. Try again.` via
  `toast.fail`, and `refresh()` reverts the pill.
- Opening the editor: `panel` stays the string union; add
  `agentsIntent: { editId?: string; new?: boolean } | null`.
  `onEditAgent` sets `panel` to `"agents"` with `{ editId }`;
  `onNewAgent` with `{ new: true }`. Cleared when the panel closes.
  Chosen over widening the `panel` union because `"agents"` is
  compared as a string by the nav actions and `setupNeeded`.

### 6. `apps/web/src/components/AgentsPanel.tsx`

Optional prop `initialAction?: { editId?: string; new?: boolean }`.
One mount effect: `editId` present and the profile exists, call
`startEdit(profile)`; profile missing (deleted since render), open
plainly; `new`, call `openNew()`.

### 7. `apps/web/src/styles.css`

Button resets on the pill trigger (`font: inherit`, cursor), hover and
focus-visible border to `--field-line`, open state (`[data-state=
"open"]`) border in the brand color, the caret, the saving spinner,
and the menu's sub-line and footnote styles. Reuse `picker-menu`,
`picker-item`, `picker-tick`, `picker-sep`; new rules only for what
those do not cover.

## Tests

- **`apps/web/src/board-card.test.ts` idiom** (SSR via
  `renderToStaticMarkup`): stage lane renders a trigger button with
  aria-label `Change the agent for the Build stage`; a stage without
  an agent renders the assign label; Backlog and Completed render
  plain spans, not buttons.
- **Server** (`apps/server/src/e2e.test.ts` or a focused route test):
  PATCHing a stage emits one `stage_updated` on the bus with the
  stage's `projectId`, observed via `ctx.bus.onBoardEvent`.
- **No auth matrix change**: the route is already listed.
- **Verify against something real** (per CLAUDE.md): start Postgres,
  `pnpm dev`, open :4401, create a project pointed at an on-disk repo,
  add two agent profiles, then on the board: switch a stage's agent
  from the pill and read the row back
  (`select name, default_agent_profile_id from stages`); open a second
  tab and confirm its lane header repaints from the new event; use
  `Edit this agent's settings` and confirm the Agents panel opens on
  that profile's form. None of this needs Docker or agent credentials,
  because nothing here starts a run.

## Risks and decisions

- **Backwards incompatible changes: none.** No migration, no API shape
  change, no stored data beyond the existing column. The new SSE event
  is the only wire change, and both deployed consumers already treat
  unknown board events as a refresh signal (verified above).
- **Last write wins.** Two people changing one stage race without a
  version check, exactly as the pipeline editor does today. Accepted;
  the emit plus refresh converges every viewer on the winner.
- **No new permission surface.** Any member can already change a
  stage's agent through the pipeline editor; this is a second door to
  the same PATCH, with tenant checks server side. Not behind
  `beta-testers`: no new endpoint, and the capability is already
  generally available (the flag rule covers unfinished capabilities,
  not new doors to shipped ones).
- **No injection surface.** Profile names render as React text nodes
  in an already-authenticated console; no agent-produced bytes are
  involved.
- **Nothing irreversible.** Every change here is a UI path plus one
  event emit; reverting the commit reverts the feature.

## Out of scope

- Terminal TUI parity (the design's follow-up note): separate surface,
  separate change.
- Emitting board events from stage create, delete, and reorder.

Not split into parts: one branch, mostly one surface, and the server
touch is a dozen lines that the web change depends on.
