# Let the board pill change a stage's agent

The web console board's stage agent name is now a menu. Click it to
switch which agent runs that stage, to clear the assignment, or to
open that agent's settings, without leaving the board.

## What landed

- **`LaneAgentMenu`** (`apps/web/src/components/LaneAgentMenu.tsx`) turns
  the `.lane-agent` pill into a Radix dropdown, following the project
  switcher. Stage lanes get the control; Backlog and Completed stay
  plain labels.
- **`PATCH /api/stages/:id`** is still the mutation. After a successful
  update it emits `stage_updated` so other open boards refresh. No new
  endpoint, no schema change, no auth-matrix entry.
- Assigning is optimistic, same idiom as dragging a card. Failure
  reverts via refresh and toasts
  `Could not change the agent for {stage}. Try again.` or, on 404,
  `This project is no longer available.`
- "Edit this agent's settings" and "Add a new agent" open the existing
  Agents panel on that form, via an `initialAction` prop.

The engineering plan was right: the save spinner waits on the PATCH
(and the refresh that settles it), not on the stream. The stream is
for other viewers.

Terminal TUI parity was left out, as the plan required. Stage
create/delete/reorder still do not emit. This stayed one branch; no
parts were filed.

## CI / test fix

PR CI failed on `pnpm test` in `apps/server` (build and typecheck
passed). Job logs are private without a GitHub token, so the named
failure on Actions is unknown.

The only server assertion that fails when this suite runs alone in
this environment is `the settings route says whether a machine login
can be shared`. It hard-asserted `canShareMachineLogin === true`. The
route already returns `false` when `runsInContainer()` is true (this
sandbox has `/.dockerenv`). The test now uses that same helper, so a
host process still has to stay visible and a container still has to
stay hidden. Product behaviour is unchanged.

GitHub `ubuntu-latest` is a VM, so that test already expected `true`
there. If Actions failed on something else, this does not invent a
second fix.

Turbo is already a workspace devDependency (`turbo` ^2.5.0). Do not
install it globally. From the repo root:

```
pnpm exec turbo run build
pnpm exec turbo run test
```

`pnpm build` and `pnpm test` are the same scripts.

## Test plan

- [x] Board SSR: a stage with an agent renders
      `Change the agent for the Build stage`; a stage without one
      renders the assign label; Backlog and Completed stay spans.
- [x] PATCHing a stage emits one `stage_updated` with that project's
      id (`apps/server/src/e2e.test.ts`).
- [x] The settings share-login test matches `runsInContainer()`.
- [x] Live server on :4400 / console on :4401: create a project,
      add two profiles, PATCH a stage from Builder to Reviewer, read
      `stages.default_agent_profile_id` back, and see `stage_updated`
      on `/api/board/:id/events`.
- [ ] Click the pill in a browser, pick another agent, confirm the
      lane header updates, then "Edit this agent's settings" and
      confirm the Agents panel opens on that profile. No browser was
      available in this sandbox, so that click path was not driven.

Web tests: 151 passed. The settings and emit server tests passed
in isolation. A full `turbo run test` in this sandbox still has one
unrelated failure: the sandbox toolchain test expects an x64 Node
tarball URL on arm64. CI is x64, so that assertion holds there.
