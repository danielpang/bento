# Code review

Feature: only show completed work from the last two weeks.

Reviewed against the feature description and `docs/bento/implementation.md`. The earlier-stage files (`product-investigation.md`, `design.md`, `engineering-requirements.md`) were not present. `bento-cloud` has no commits on this branch.

## Does the change do what the requirements said?

Yes, for the web and TUI project boards.

`GET /api/features?projectId=` is what the web board (`apps/web/src/App.tsx:712`) and the TUI (`apps/tui/src/app.tsx:359`) load. The filter in `apps/server/src/routes/features.ts:378-397` keeps every card that is not `done`, and keeps a `done` card only when `feature_events` has a `status_changed` to `done` at or after `now() - interval '14 days'`. That matches the requirement and the implementation note: unfinished and cancelled cards stay, a card completed twice stays if the latest completion is recent, and `updated_at` is not used.

The payload and query params are unchanged, so clients do not need a contract change.

Two surfaces still show every completed card:

- The Mac board reads `GET /api/projects/:id/board/plain` (`apps/server/src/routes/projects.ts:893`), which still selects every feature in the project.
- MCP `list_features` (`apps/server/src/routes/mcp-endpoint.ts:508-518`) has its own unfiltered query.

Those are outside the endpoint the implementation chose. They are not bugs in the filter. They are leftover lists if "a project" was meant to include every client.

No UI code changed, so there is no screenshot.

## Is it covered by tests?

Yes, for the cases the requirement named.

`apps/server/src/e2e.test.ts:3984-4030` is a real PostgreSQL request against `GET /api/features`. It checks:

- an unfinished card stays
- a completion 13 days ago stays
- a card completed 15 days ago and again 13 days ago stays
- a completion 15 days ago is hidden
- a cancelled card stays
- a recent completion on another project does not appear on this board

The last assertion was added in this review. The original test used only one project, so it could not see the AND/OR grouping bug below.

Not covered, and not required to merge: the exact 14-day boundary, and a `done` row with no `status_changed` event. The implementation already says that second case is hidden on purpose, same as the completions chart.

## Does it introduce bugs?

One did, and it is fixed on this branch.

Drizzle's `and()` wraps the whole clause but not each term. The first version compiled to:

```sql
where ("features"."project_id" = $1 and "features"."status" <> 'done' or exists (...))
```

AND binds tighter than OR, so a recent completion on any card the session can see (another project in the same organization) satisfied the WHERE and appeared on this board. Confirmed by printing `toSQL()` from the same helpers.

The list now uses `or(ne(features.status, "done"), exists (...))` at `apps/server/src/routes/features.ts:386-396`, which compiles to `project_id = $1 and (status <> $2 or exists (...))`. The new assertion at `apps/server/src/e2e.test.ts:4029` would fail if the grouping slipped again.

Two side effects of putting the window on the shared list, not on the board:

1. Removing a project (`apps/web/src/components/ProjectsSettings.tsx:170`) counts `listFeatures`. The confirm copy can say "Its 3 cards" when older done cards will also be deleted. The delete itself still counts every row (`apps/server/src/routes/projects.ts:860-872`). The copy is wrong, the delete is not.
2. Removing a stage (`apps/web/src/components/StageConfig.tsx:325`) counts occupants from the same filtered list. Done cards keep `currentStageId`. A stage that only holds old completed cards looks empty, then `DELETE /api/stages/:id` (`apps/server/src/routes/stages.ts:134-139`) returns 409. No card is lost; the warning is.

A `?feature=` link to an old completed card still loads the project (`apps/web/src/App.tsx:757`), but the drawer reads `selected` from the filtered list (`apps/web/src/App.tsx:964`), so the card does not open. Board live updates refetch `listFeatures`, so an old done card does not come back over SSE.

## Does it read clearly?

Yes. The comment above the predicate says why `feature_events` is the clock and why `updated_at` is not. After the fix it also says why `or()` is there. The test names say what each row is for. A later reader can change the window in one place: the interval in `features.ts:394` and the 13/15 day fixtures in the test.

## Verdict

Ready to merge. The board list does what the requirement asked, the dangerous grouping is fixed and tested, and the leftover Mac/MCP lists plus the delete-copy undercount are not blockers for this change.
