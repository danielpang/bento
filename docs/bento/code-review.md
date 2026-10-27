# Code review: Artifacts tab

**Verdict: do not merge.** The branch does not implement the feature. It only adds four planning documents from earlier stages. A user who opens the console still cannot reach an Artifacts tab, list cards that have artifacts, or view them from a project-wide grid.

Compared to `origin/main`, this branch adds 323 lines across:

- `docs/bento/product-investigation.md`
- `docs/bento/design.md`
- `docs/bento/engineering-requirements.md`
- `docs/bento/implementation.md`

`bento-cloud` is unchanged, which is correct: that repository has no artifact data or console surface.

The implementation plan itself is clear enough to build from. Nothing in application code was written, so there is no UI to screenshot.

## 1. Does the change do what the requirements asked?

No.

The requirements (`docs/bento/engineering-requirements.md`) asked for a shipped, read-only web workspace:

- `GET /api/projects/:id/artifacts` returning one `ProjectArtifactCard` per pipeline card
- `listProjectArtifacts` on the API client
- `/artifacts` grid and `/artifacts/:cardId` detail, with nav between Board and Sessions
- reuse of `ArtifactViewer`
- `artifacts_tab_opened` / `artifact_opened` analytics
- `docs/web-app.md` update

None of that is in the tree. Concrete gaps:

- **No project aggregate endpoint.** `apps/server/src/routes/projects.ts` still has no `runArtifacts` import (lines 9–21) and no `GET /:id/artifacts` handler. The closest sibling is `GET /:id/sessions` at line 684. Visiting the required URL cannot succeed because the route does not exist.
- **No client method.** `packages/api-client/src/client.ts` still only has per-card `listArtifacts` (line 1178). `listProjectArtifacts` and `ProjectArtifactCard` are absent from `packages/api-client/src`.
- **No Artifacts screen or nav item.** `apps/web/src/App.tsx` line 462 still types the workspace as `"board" | "sessions" | "spend"`. Lines 1249–1250 still place Sessions immediately after Board. `/artifacts` is not recognized, so that path falls through to the board (lines 461–463). There is no `ArtifactsPage.tsx`.
- **No analytics wrapper.** `apps/web/src/posthog.ts` still exports `captureException` only (line 82). `FeatureDrawer.tsx` opens artifacts (line 1237) without emitting `artifact_opened`.
- **Docs and product copy.** `docs/web-app.md` does not mention the Artifacts tab. The design mockup cited in `docs/bento/design.md` (`/workspace/artifacts/artifacts-tab.html`) is also not present.

What *is* sound in the earlier docs, and should be followed when this is built:

- One tile per card, not per artifact
- Web only, not beta-gated, swarm artifacts excluded
- `canAccessProject` then 404, tenant matrix entry required
- Preview is the newest artifact; markdown excerpt capped at 2,000 characters; no `storageKey` or full `content`
- Existing `GET /api/features/:id/artifacts` and `ArtifactViewer` reused
- Artifacts is a sibling workspace: do not start board snapshots or the board SSE stream solely for `/artifacts`

One doc inconsistency for the implementer, not a code defect: `docs/bento/design.md` line 45 describes the card as `{ id, name, preview | null }`. Engineering and the implementation plan use `{ featureId, title }` and a non-null preview. Follow the engineering contract. Cards only appear when they have artifacts, so preview is never null.

## 2. Is it covered by tests?

No. The required tests were not added.

| Required coverage | Where it should have landed | Present? |
|---|---|---|
| Foreign-tenant 404 | `apps/server/src/auth.e2e.test.ts` matrix, next to the other project routes around lines 956–979 | No. Per-card artifact routes exist at lines 1000–1008; `GET /api/projects/${project.id}/artifacts` does not. AGENTS.md treats a missing matrix row as an unchecked route. |
| Aggregate contract | `apps/server/src/e2e.test.ts`: grouping, order, kinds, excerpt cap, swarm exclusion, empty project, no `content`/`storageKey` | No |
| API client types | compile `ProjectArtifactCard` / `listProjectArtifacts` | No new type |
| Web | grid order, pluralization, empty/loading/error/detail, preview fallback, viewer focus, route recognition, nav current state, analytics payloads, no board work on `/artifacts` | No `ArtifactsPage` and no new web tests |
| Query plan | `EXPLAIN (ANALYZE, BUFFERS)` before any index | Not run; no query exists |

I did not run `pnpm test` or `pnpm build` as proof that the feature works. There is no feature code to exercise. The existing suite cannot cover an endpoint, page, or client method that is not in the tree.

## 3. Bugs

There is no new application code, so there are no new runtime bugs to report. Shipping this branch as the feature would be the bug: the product still has no project-wide artifact list.

Existing behavior that the next change must not break, because the feature is supposed to reuse it:

- `GET /api/features/:id/artifacts` already returns metadata only after `getAccessibleFeature` (`apps/server/src/routes/features.ts`).
- `ArtifactViewer` already sandboxes HTML. Do not add `allow-same-origin` or render HTML on the console origin.
- `workScreen` in `apps/web/src/App.tsx` line 464 is `screen === "board" || (beta && screen === "sessions")`. If Artifacts is accidentally added to `workScreen`, `/artifacts` will start board refresh and the board SSE stream, which the requirements forbid.

## 4. Clarity for the next person

The planning documents read clearly. `docs/bento/implementation.md` is a complete build brief: endpoint shape, access rules, UI states, analytics fields, and the verification commands. Someone can implement from that file plus `docs/bento/engineering-requirements.md` without rediscovering the product decisions.

There is no application code to review for naming, structure, or comments.

## What must land before this is ready

1. Implement the server endpoint, client method, Artifacts page, nav, analytics, and `docs/web-app.md` update as specified in `docs/bento/engineering-requirements.md` and `docs/bento/implementation.md`.
2. Add the tenant-matrix row and the aggregate/UI tests listed there.
3. Run `pnpm typecheck`, `DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test`, and `pnpm build` from `/workspace/bento`.
4. Verify the grid and detail in a browser (direct URLs, project switch, keyboard focus return, 200-item notice). Attach screenshots then.
5. Run `EXPLAIN (ANALYZE, BUFFERS)` on the aggregate before adding any index.

Until those exist, this branch should not merge.
