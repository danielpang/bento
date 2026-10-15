# Engineering requirements: Artifacts tab

## Scope and decisions

Add a web-only, read-only Artifacts workspace at `/artifacts`, between Board and Sessions in the existing project navigation. The grid unit is a pipeline card, ordered by its newest artifact. Selecting a card opens `/artifacts/:cardId`, which lists that card's artifacts and opens the existing `ArtifactViewer`. Swarm artifacts, TUI changes, editing, deletion, search, filters, and cross-project browsing are out of scope.

Ship this to all users, not behind `beta-testers`. This follows the approved design and is safe because it adds only reads through the existing artifact authorization and rendering paths.

The implementation belongs entirely in `bento`. `bento-cloud` owns billing and usage but has no artifact data, routes, or console code, so it requires no change.

## Existing system

- `packages/db/src/schema/app.ts` defines `features` and `runArtifacts`. A pipeline artifact belongs to one feature and run, stores text in `content` or binary data behind `storageKey`, and carries a `type` discriminator. The table already has forced RLS and an organization-inheritance trigger.
- Existing indexes are `features_project_idx(project_id)` and `run_artifacts_feature_idx(feature_id, created_at)`. They support a project-to-features join followed by the per-feature artifact aggregate and newest-row lookup.
- `apps/server/src/routes/features.ts` exposes `GET /api/features/:id/artifacts`, newest first with a hard limit of 200. It returns metadata only after `getAccessibleFeature` succeeds.
- `apps/server/src/routes/artifacts.ts` resolves each artifact through `getAccessibleArtifact`; it never accepts or returns a storage key. Its content route applies a sandbox CSP and forces executable formats to download.
- `packages/api-client/src/client.ts` and `types.ts` expose `listArtifacts`, `getArtifact`, and artifact content URLs.
- `apps/web/src/App.tsx` owns the workspace route selection, project picker, top navigation, and shared board chrome. It currently recognizes `board`, `sessions`, and `spend` screens.
- `apps/web/src/components/ArtifactViewer.tsx` already renders markdown, Mermaid, images, HTML in `iframe sandbox="allow-scripts"`, and generic files. It must remain the only full artifact viewer.
- Browser PostHog setup is in `apps/web/src/posthog.ts`; autocapture and pageview capture are deliberately disabled.

## API contract

Add `GET /api/projects/:id/artifacts` to `projectRoutes` in `apps/server/src/routes/projects.ts`.

The endpoint accepts no body or query parameters in v1. It must call `canAccessProject(ctx, c, id)` before querying and return `404 { "error": "not found" }` for a missing or foreign project. The query runs through `tenantDb`, joins `features.project_id = :id` to pipeline rows in `run_artifacts`, groups by feature, and sorts by `latestCreatedAt DESC, feature.id ASC` for deterministic output.

Response `200`:

```ts
interface ProjectArtifactCard {
  featureId: string;
  title: string;
  artifactCount: number;
  kinds: RunArtifactKind[]; // unique, stable display order
  latestCreatedAt: string;
  preview: {
    artifactId: string;
    kind: RunArtifactKind;
    // Present only for markdown stored inline. Cap at 2,000 characters.
    markdownExcerpt?: string;
  };
}
```

The preview is the newest artifact, not the newest image. Images use the existing authenticated `/api/artifacts/:id/content` URL; markdown renders the returned excerpt with the existing `Markdown` component; HTML, Mermaid, and generic files show a kind icon. The excerpt avoids one content request per markdown tile and is small enough to bound response growth. It is still hostile agent text and must go through `react-markdown` with raw HTML disabled. The response must never contain `content` beyond that excerpt, `storageKey`, or artifact bytes.

Only `run_artifacts.type = 'pipeline'` rows are eligible. Although the feature join already excludes swarm rows by shape, state the discriminator in the query so a future schema change cannot widen this endpoint silently.

Keep card detail on `GET /api/features/:id/artifacts`. A returned array of length 200 means the UI shows "Showing the 200 most recent artifacts." No second detail endpoint or duplicated viewer is needed.

## Database and migration plan

No table, column, constraint, RLS policy, trigger, or migration is needed. The source of truth remains `run_artifacts`; "has artifacts" must not be denormalized onto `features`, because it would introduce write synchronization and backfill work for a derived fact.

The existing indexes match the access path. Before merging, run `EXPLAIN (ANALYZE, BUFFERS)` against representative data. Add a new index only if that evidence shows a material sequential scan. An index migration would increase write and storage cost and is not justified speculatively.

There is no destructive or irreversible data operation in this feature. Deleting a card or run retains current cascade behavior and can make a card disappear from the grid; this feature does not alter that policy.

## Implementation by module

### Server

- `apps/server/src/routes/projects.ts`: import `runArtifacts`; add the authorized aggregate endpoint and explicit pipeline filter. Use a lateral subquery or `DISTINCT ON (feature_id)` for the newest preview row, and aggregate count and distinct kinds in the same request. Convert database count values to JSON numbers.
- `apps/server/src/auth.e2e.test.ts`: add `GET /api/projects/${project.id}/artifacts` to the foreign-tenant route matrix. A route omitted from this matrix is incomplete.
- Add an endpoint integration test beside the project route coverage (currently concentrated in `apps/server/src/e2e.test.ts`). Seed multiple cards, multiple artifact kinds and timestamps, plus a swarm artifact. Assert grouping, ordering, counts, unique kinds, preview selection/excerpt cap, swarm exclusion, empty project behavior, and absence of `content`/`storageKey`.

### API client

- `packages/api-client/src/types.ts`: add `ProjectArtifactCard` using the existing `RunArtifactKind`.
- `packages/api-client/src/client.ts`: add `listProjectArtifacts(projectId)` calling `/api/projects/${encodeURIComponent(projectId)}/artifacts`.
- Export the new type through the package's existing type export path.

### Web console

- Add `apps/web/src/components/ArtifactsPage.tsx`. It receives `client`, `projectId`, and an optional `cardId` parsed by the parent. The grid loads `listProjectArtifacts`; the detail loads `listArtifacts(cardId)`. Abort or ignore stale requests when either id changes so a late response from the previous project cannot repaint the page.
- Reuse `ArtifactViewer` for modal viewing. Keep the selected artifact in page state and return focus to the triggering link after close. "Open in new tab" targets `/artifact/:id`. "Open card" targets `/?project=:projectId&feature=:cardId`, matching the board's existing deep-link convention.
- In `apps/web/src/App.tsx`, lazy-load `ArtifactsPage`, add `artifacts` to the `screen` union, recognize `/artifacts` and `/artifacts/:cardId`, add the navigation entry immediately after Board, and render an artifacts-shaped Suspense fallback. Artifacts is a sibling workspace: do not load board snapshots, sessions, or open the board SSE stream solely for this screen. Continue loading the shared project list and picker. Hide the entry only while the swarm board itself is active, matching the design.
- Add grid/detail/skeleton styles in `apps/web/src/styles.css` using `repeat(auto-fill, minmax(240px, 1fr))` and a 16:10 preview. Respect `prefers-reduced-motion`, two-line title clamping, responsive layout, and existing focus tokens.
- Extend `apps/web/src/components/Skeleton.tsx` with `ArtifactsGridSkeleton` and detail rows rather than displaying `BoardSkeleton` at these routes.
- Extend `apps/web/src/posthog.ts` with a narrow `captureEvent(name, properties)` wrapper and add `capture` to its internal client type. Emit `artifacts_tab_opened` once per mounted project view and `artifact_opened` with `source: "tab" | "card_panel"`, `project_id`, `feature_id`, `artifact_id`, and `kind`. Update `FeatureDrawer.tsx` to emit the card-panel source. Do not put titles, paths, excerpts, or other agent/user text in analytics.
- Update `docs/web-app.md` with the route, project scoping, and artifact security behavior.

## UI behavior and errors

- Loading: heading plus eight inert skeleton tiles with `aria-busy="true"`; detail uses skeleton rows.
- Empty project: "No artifacts yet" and a real link to Board. No projects continues to use the existing new-project state owned by `App.tsx`.
- Project request failure: inline `role="alert"`, "Couldn't load artifacts.", and a retry button. A 404 uses the approved unavailable-project copy and project chooser.
- Detail 404: "This card no longer exists." and a link back to `/artifacts`.
- Failed image preview falls back silently to the kind icon. A failed artifact open keeps the existing viewer error behavior and offers retry/open-in-new-tab as specified by the design.
- Tiles and artifact rows are real links or buttons with accessible names. The Artifacts navigation anchor receives `aria-current="page"` for both grid and detail routes.

## Security requirements

- Preserve all three tenant layers: explicit `canAccessProject`, tenant-scoped database transaction/RLS, and existing inherited organization ids.
- Never expose or derive access from a bucket key. Every image and full-content read continues through the artifact id route and its access helper.
- Never render artifact HTML on the console origin. Do not add `allow-same-origin` to the iframe sandbox or relax the content route CSP.
- Treat markdown excerpts, names, and paths as untrusted display data. React escaping and the existing markdown renderer are required; do not use `dangerouslySetInnerHTML`.
- Do not include artifact text, card titles, or paths in analytics.

## Verification and acceptance

Automated checks:

1. Server integration tests cover the aggregate contract and foreign-tenant 404.
2. API-client/type checks compile the new response shape.
3. Web component tests cover grid ordering, pluralization, empty/loading/error/detail states, preview fallback, viewer open/close focus, route recognition, nav ordering/current state, and analytics payloads.
4. Run `pnpm typecheck`, `DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test`, and `pnpm build` from `/workspace/bento` with the repository's pinned pnpm and supported Node version.
5. Start Postgres, migrate a disposable/local database, run the console, and verify in a browser with at least two cards and image/markdown/HTML artifacts: project switching, direct URLs, back/forward behavior, mobile navigation, keyboard operation, viewer sandboxing, and the 200-item notice.
6. Inspect the project aggregate with `EXPLAIN (ANALYZE, BUFFERS)` before deciding whether any index migration is necessary.

Acceptance is met when an authorized user can open Artifacts between Board and Sessions, see every card in the selected project that has pipeline artifacts in newest-activity order, inspect its artifacts through the existing safe viewer, deep-link to grid/detail routes, and receive no information about another tenant or swarm artifacts.

## Risks and rollout

- The aggregate is unpaginated by the approved v1 scope. Response size grows with cards that have artifacts. It returns one bounded metadata row per card, so accept this for v1 and measure latency/row counts; add cursor pagination later if production data warrants it.
- Markdown excerpts increase the summary response compared with metadata alone. The 2,000-character cap is mandatory.
- Route integration in `App.tsx` is coupled to board loading and streaming. Tests must prove `/artifacts` does not start unnecessary board work and that project switching cannot show stale artifacts.
- Artifact content is adversarial. Reusing `ArtifactViewer` is a security requirement, not only a code-reuse preference.
- Shipping without a beta gate means rollback is code rollback. Since there is no migration or stored state, rollback is clean and leaves artifact data unchanged.
