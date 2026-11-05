# Implementation plan: Artifacts tab

## Outcome

Add a web-only Artifacts workspace at `/artifacts`, between Board and Sessions. It shows one tile per pipeline card with artifacts, newest activity first. `/artifacts/:featureId` lists that card's artifacts and opens them with the existing `ArtifactViewer`.

This change belongs only in `bento`. `bento-cloud` has billing and usage concerns but no artifact storage, API, or console surface.

## Existing data and migrations

Use `packages/db/src/schema/app.ts` as-is:

- `features.project_id` identifies the selected project.
- `run_artifacts.feature_id` identifies the card. `type = 'pipeline'` distinguishes these rows from swarm artifacts.
- Artifact metadata is `kind`, `mime`, `size`, stage fields, path, and `created_at`. Text is in `content`; binary data is referenced internally by `storage_key`.
- `features_project_idx(project_id)` and `run_artifacts_feature_idx(feature_id, created_at)` already support the join and newest-artifact lookup.

No table, column, trigger, RLS policy, migration, or backfill is needed. Do not add a `has_artifacts` column to `features`; it is derived state that would need synchronization. There is no destructive or irreversible data operation. Rollback is code-only.

Before merge, run `EXPLAIN (ANALYZE, BUFFERS)` with representative project/card counts. Add an index migration only if that shows a material scan. The expected access path does not justify speculative write and storage cost.

## Server and API contract

In `apps/server/src/routes/projects.ts`, add `GET /api/projects/:id/artifacts` to `projectRoutes`.

The endpoint accepts no body or query parameters. First call `canAccessProject(ctx, c, id)` and return `404 { "error": "not found" }` for missing or foreign projects. Query through `tenantDb`, join `features` to `run_artifacts`, explicitly filter `run_artifacts.type = 'pipeline'`, group per feature, and sort by `latestCreatedAt DESC, featureId ASC`.

Use one aggregate query with a lateral newest-row lookup or `DISTINCT ON (feature_id)`. Convert Postgres counts to JSON numbers and put distinct kinds into the stable enum display order.

Return:

```ts
interface ProjectArtifactCard {
  featureId: string;
  title: string;
  artifactCount: number;
  kinds: RunArtifactKind[];
  latestCreatedAt: string;
  preview: {
    artifactId: string;
    kind: RunArtifactKind;
    markdownExcerpt?: string;
  };
}
```

`preview` is the newest artifact. Include at most 2,000 characters of inline content only when that artifact is markdown. Never return full content, `storageKey`, or bytes. Images continue to load through the authenticated `/api/artifacts/:id/content` route.

Keep card detail on the existing `GET /api/features/:id/artifacts`, which returns metadata newest first with a 200-row limit. Do not create another detail endpoint or content-serving path.

Tests:

- Add the new route to the foreign-tenant matrix in `apps/server/src/auth.e2e.test.ts`.
- Add an integration test in `apps/server/src/e2e.test.ts` covering multiple cards, timestamps and kinds; unique kinds; deterministic ordering; preview selection; the 2,000-character excerpt cap; empty projects; swarm exclusion; and absence of full `content` and `storageKey`.

## API client

In `packages/api-client/src/types.ts`, add and export `ProjectArtifactCard` using the existing `RunArtifactKind`. In `packages/api-client/src/client.ts`, add:

```ts
listProjectArtifacts(projectId: string): Promise<ProjectArtifactCard[]>
```

It calls `/api/projects/${encodeURIComponent(projectId)}/artifacts`.

## Web implementation

Add `apps/web/src/components/ArtifactsPage.tsx` and lazy-load it from `apps/web/src/App.tsx`.

Update route parsing so the screen union includes `artifacts`, recognizes `/artifacts` and `/artifacts/:featureId`, and marks Artifacts current for both. Insert its navigation item directly after Board. Hide it only while the swarm board is actually displayed, matching the existing card-workspace navigation rule. Ship without a beta wrapper, as approved in the design; the feature is read-only and uses existing authorization and rendering paths.

Treat Artifacts as a sibling workspace, not a board view. The shared project list/picker stays active, but `workScreen`, `refresh`, and stream effects must not load board snapshots, sessions, profiles, or the board SSE stream solely for `/artifacts`. On project or feature changes, abort requests or ignore stale responses so an older project cannot repaint the page.

Grid behavior:

- Load `listProjectArtifacts(projectId)` and render `repeat(auto-fill, minmax(240px, 1fr))` tiles in server order.
- Use a 16:10 preview: authenticated image URL for images; the existing safe Markdown renderer for excerpts; a neutral kind icon for HTML, Mermaid, and generic files.
- Show card title, count, kind chips, and relative update time. Each tile is a real link to `/artifacts/:featureId`.
- Provide eight inert skeleton tiles, the approved empty state with a Board link, an inline retryable error, and unavailable-project copy for a 404.

Detail behavior:

- Load the existing `listArtifacts(featureId)` call and show newest first with path basename, kind, stage, size, and time.
- “Open card” uses the existing `/?project=:projectId&feature=:featureId` deep link. “Open in new tab” uses `/artifact/:id`.
- Open the existing `ArtifactViewer` modal. Store the triggering element and restore focus when it closes.
- If exactly 200 artifacts are returned, show “Showing the 200 most recent artifacts.” Handle a feature 404 as a deleted card and link back to `/artifacts`.

Extend `apps/web/src/components/Skeleton.tsx` for grid and detail skeletons, and add responsive/focus/reduced-motion styles in `apps/web/src/styles.css`. Do not duplicate `ArtifactViewer` or render HTML on the console origin.

## Analytics and documentation

In `apps/web/src/posthog.ts`, add `capture` to the narrow internal client type and export a typed event wrapper. Emit:

- `artifacts_tab_opened` once per mounted project view.
- `artifact_opened` with `source: 'tab' | 'card_panel'`, `project_id`, `feature_id`, `artifact_id`, and `kind`.

Update `FeatureDrawer.tsx` for the card-panel source. Never send titles, paths, excerpts, or other user/agent text. Update `docs/web-app.md` with both routes, project scoping, and the existing sandbox/content security rules.

## Risks and verification

- The endpoint is intentionally unpaginated and grows one bounded row per card. Measure latency and row count after release; add cursor pagination later if needed.
- Markdown excerpts are hostile agent output. Render with the existing Markdown component and raw HTML disabled. Keep the 2,000-character cap.
- Full HTML remains in `ArtifactViewer` with `iframe sandbox="allow-scripts"`; never add `allow-same-origin` or loosen the content route CSP.
- App routing is coupled to board refresh and streaming. Tests must prove `/artifacts` does not start board work and project switching cannot show stale data.

Run from `/workspace/bento` with the pinned pnpm and Node 22 or newer:

```sh
sudo pg_ctlcluster 16 main start
pnpm typecheck
DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test
pnpm build
```

Then run the app against migrated local Postgres and verify two cards with markdown, image, and HTML artifacts: direct grid/detail URLs, project switching, browser back/forward, mobile layout, keyboard focus restoration, image fallback, safe HTML sandboxing, and the 200-item notice.
