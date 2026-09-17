# Engineering requirements: clean up sandboxes when a card is done, keep the artifacts

Stage: Engineering requirements. This document turns the card into a plan
someone else can build from. It is grounded in what is on `main` today, with
file references throughout.

## What the card asks

1. Local mode: delete the card's sandbox when the card is marked done.
2. Make sure the artifacts agents produced for the card are saved first, and
   are never deleted by the cleanup.
3. Multi mode: make sure artifacts survive the sprite being destroyed.

## What already exists on main (audit)

Much of this card shipped in "Meter what a card costs, and reclaim the
machine when it is done" (PR #36) and the artifact capture work. The audit
matters because the remaining gap is narrower than the card text suggests.

**Sandbox reaping is already wired to every door into "done".**

- `queueSandboxReap` (`apps/server/src/orchestrator/reap-sandbox.ts`) queues a
  `sandbox.reap` job. It is called when the gate evaluator advances a card off
  the last stage (`gate-evaluator.ts:454`) and when a person drops a card on
  the Done lane, which calls `finishFeature` (`gate-evaluator.ts:697`). Those
  are the only two paths that set `features.status = 'done'`; the MCP card
  tools are read and create only.
- The worker registered in `registerJobs` (`run-executor.ts:2086`) runs
  `reapSandbox`, which destroys every non-destroyed `sandboxes` row the card
  holds via `ctx.driver.destroy`, refuses (throws, so the job retries) while a
  run is in `ACTIVE_RUN_STATUSES`, and re-verifies with `driver.exists` where
  the driver can answer.
- A boot sweep, `reapFinishedSandboxes`, catches cards that finished before
  the queue existed or whose jobs were lost.
- `registerJobs` runs in both modes (`server.ts:214`), and the Docker driver's
  `destroy` force-removes the `bento-sbx-<featureId>` container, so in local
  mode the container itself is already reclaimed at done.

**Artifacts are already stored outside the sandbox, and the ordering is safe.**

- `captureRunArtifacts` (`orchestrator/capture-artifacts.ts`) runs at the end
  of every successful run, inside `run-executor.ts` at line 984, before
  `finishRun` and before `gate.evaluate` is queued. A reap can only be queued
  by that gate evaluation, so capture always completes first, and `reapSandbox`
  additionally refuses while any run is active.
- Captured artifacts live in Postgres (`run_artifacts` rows, inline text) and
  in the artifact store (`ctx.artifacts`) for binary bytes. Local mode always
  has a store: `createArtifactStore` (`artifact-store.ts:147`) falls back to
  `DiskArtifactStore` under `BENTO_DATA_DIR/artifacts`. Neither location is
  touched by any driver's `destroy`, so destroying a sprite or a container
  cannot take artifacts with it. The multi mode half of the card (point 3) is
  therefore already true, with one existing caveat: a multi deploy with no
  bucket gets `ctx.artifacts = null`, capture keeps text artifacts only, and
  the server already warns loudly at boot (`server.ts:177`).

**What is genuinely not cleaned up in local mode.**

- The card's host workspace, `<BENTO_DATA_DIR>/worktrees/<featureId>`, one git
  worktree per repository plus whatever the agents left beside them
  (`node_modules`, build output). This directory is what the container bind
  mounts as `/workspace`, so it is where most of a finished card's disk
  actually is. Nothing removes it at done. Only the feature delete route
  removes the worktrees (`routes/features.ts:543`), and even that leaves the
  workspace directory itself behind with any non-git leftovers in it.
- The Docker image is not per card. `BENTO_SANDBOX_IMAGE` (default
  `bento-sandbox:dev`) is shared by every sandbox, so "delete sandbox images"
  from the card text must not be read literally: deleting the image would
  break every other card and the next run would just rebuild it. The per-card
  disk is the container's writable layer (already reclaimed) plus the
  workspace (the gap). This is a deliberate decision, not an omission.

## Requirements

R1. When a card ends (done via the gate, done via the Done lane, and the boot
    sweep's catch-up for both plus cancelled), local mode must reclaim the
    card's workspace directory in addition to its container: every repository
    worktree deregistered from its origin repository, and the workspace
    directory removed recursively.

R2. Cleanup must never touch `run_artifacts` rows or artifact store bytes, in
    either mode. Artifacts are the durable record of the card.

R3. Cleanup must never run while a run is active on the card, and must be
    retryable: a partial failure leaves state that a rerun of the same job
    finishes.

R4. Committed work must survive. Worktree branches are refs in the origin
    repository, so removing the worktree keeps every commit; the existing
    publish route already recreates worktrees on demand
    (`routes/features.ts:1164`, "Ensured rather than assumed"), and reopening
    a card must keep working: the next run recreates the worktree from the
    branch and reprovisions the container (the sandbox row upsert at
    `run-executor.ts:340` already handles a reaped row coming back).

R5. Multi mode needs no behavior change, but the invariant in R2 gets a test
    so it cannot regress silently.

## Design

No schema migration and no API change. Four code changes and tests.

### 1. `WorktreeManager.removeWorkspace` (packages/sandbox/src/worktree.ts)

New method beside `remove`:

```ts
async removeWorkspace(
  repos: { name: string; localPath: string }[],
  featureId: string,
): Promise<void>
```

For each repository it calls the existing `remove` (which runs
`git worktree remove --force` and tolerates "already gone"), then deletes
`this.workspacePath(featureId)` with `fs.rm(..., { recursive: true, force:
true })`. The manager owns the workspace layout, so the knowledge of what a
workspace is stays in one place. Deleting the directory after deregistering
the worktrees matters: removing a live worktree directory with plain `rm`
leaves a stale registration in the origin repository that later
`worktree add` calls trip over (see the `isStaleRegistration` machinery in
the same file).

### 2. Workspace cleanup in `reapSandbox` (orchestrator/reap-sandbox.ts)

Restructure `reapSandbox` so the active-run guard always runs first, then the
machine loop, then a new final step:

- Look up the feature's project repositories (`features` row for `projectId`,
  then `repositories` by project) and call
  `ctx.worktrees.removeWorkspace(repos, featureId)`.
- Drop the early return on "no non-destroyed sandbox rows" for this step: a
  card whose provisioning failed has worktrees but may have no sandbox row,
  and a job retry after the rows were marked destroyed still has to finish
  the workspace. The machine loop keeps its per-row behavior unchanged.
- Run it for every driver. On sprite deployments no worktrees are created
  (`run-executor.ts:232` skips `ensureAll` for sprites), the directory does
  not exist, and the removal is a no-op. Simpler and safer than gating on
  provider, because a deployment that switched drivers mid-card still gets
  cleaned.
- If the feature row is gone (deleted), skip the repository lookup and still
  remove the workspace directory by path.

The existing queue semantics carry the retry story: the job throws on a
still-active run or a machine that will not die, pg-boss retries, and the
workspace step is idempotent.

### 3. Feature delete uses the same path (routes/features.ts:543)

Replace the per-repository `ctx.worktrees.remove` loop with
`removeWorkspace`. Same semantics the route already documents (uncommitted
work goes), plus it stops leaving the workspace directory husk behind.

### 4. Boot sweep catches pre-existing leftovers (reapFinishedSandboxes)

The current sweep only sees non-destroyed `sandboxes` rows, so every card
finished before this change keeps its workspace forever, and the first deploy
of this change is the only thing that will ever reclaim those. Extend the
sweep: after the existing pass, list the entries of
`<BENTO_DATA_DIR>/worktrees`. Each entry name is a feature id by
construction. For each entry:

- feature exists and is done or cancelled, and has no active run: clean via
  the same `reapSandbox` path;
- feature does not exist (deleted before the husk fix): remove the directory;
- anything else (active card, unparseable name): leave it alone.

Same error containment as the existing sweep: one failure logs and moves on.

### Tests

- New `apps/server/src/orchestrator/reap-sandbox.test.ts` (none exists
  today), following `packages/sandbox/src/worktree.test.ts` for building a
  real temporary git repository and a real `WorktreeManager`, with a fake
  driver. Asserts: worktree deregistered and workspace directory gone after
  reap; `run_artifacts` rows and `DiskArtifactStore` bytes untouched (R2);
  an active run makes the job throw and leaves the workspace (R3); a second
  reap of the same feature is a clean no-op (R3); a feature with worktrees
  but no sandbox rows still gets its workspace removed.
- A sweep test covering the three sweep cases above.
- A reopen test: reap, then `ensureAll` again on the same branch, and the
  worktree comes back with the committed history intact (R4).

No new HTTP routes, so no addition to the `auth.e2e.test.ts` matrix.

## Risks, irreversible actions, compatibility

- **Irreversible and the one real behavior change:** marking a card done in
  local mode now discards uncommitted changes sitting in that card's
  workspace. Committed work is safe (branch refs live in the origin
  repository). This is the same contract the delete route already states in
  its own comment, agents commit their work as part of every stage, and the
  active-run guard prevents pulling the workspace out from under a running
  agent. The alternative (keep workspaces forever) is the bug this card
  files. Accepted, and worth one line in the release notes.
- The boot sweep deletes directories based on feature status. It is scoped
  strictly to `<BENTO_DATA_DIR>/worktrees`, never follows a path out of it,
  and skips anything it cannot positively match to a finished or deleted
  feature.
- No backwards incompatible API or schema change. No migration. The `mac`,
  `tui`, and `web` apps are untouched.
- Publish after done: unchanged in both modes. Local recreates worktrees on
  demand; multi already answers 409 once the sprite is gone, which is
  existing behavior, not something this change introduces.

## Deliberately out of scope, with reasons

- **Deleting the shared sandbox image.** `bento-sandbox:dev` serves every
  card; per-card disk is the writable layer and the workspace.
- **A last-chance artifact capture at reap time.** Capture skips failed runs
  on purpose (`capture-artifacts.ts` header: half-finished files presented as
  stage output mislead the reviewer), and every successful run already
  captured before the gate could move the card. A reap-time capture would
  reintroduce exactly the misleading case the capture design excludes.
- **Removing artifact store bytes when a feature is deleted.** Today
  `run_artifacts` rows cascade on delete but nothing calls
  `ctx.artifacts.remove`, so the bytes are orphaned in the store. That is a
  storage leak in the opposite lifecycle direction from this card (it deletes
  too little, not too much) and preserving artifacts is this card's point.
  Noted here so it can be filed as its own card.
