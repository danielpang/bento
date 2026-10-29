# Quality engineering: Artifacts tab

## Initial verification (before changes)

Code review on this branch was correct: only planning documents existed; the Artifacts tab, API, client method, and tests were missing. Acceptance criteria were **not** met.

## Repository test command

Command (from `/workspace/bento`):

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm test
```

**Result:** exit code 1. Turbo runs package tests in parallel; in this sandbox several packages failed with `Promise resolution is still pending but the event loop has already resolved` (for example `@bento/db`, `@bento/core`, `@bento/sandbox`, and many `@bento/web` files when run under turbo). `@bento/db` also failed because Postgres is not reachable on `localhost:5439` here (no cluster on 5432/5439).

**Isolated runs (same commit, after implementation):**

| Command | Result |
|--------|--------|
| `pnpm typecheck` | Pass (24/24 tasks) |
| `pnpm build` | Pass |
| `cd apps/web && node --test --import tsx "src/**/*.test.ts"` | **424/424 pass** (includes new artifacts tests) |
| `pnpm --filter @bento/api-client test` | **16/16 pass** (includes `listProjectArtifacts` URL test) |
| `cd apps/server && DATABASE_URL=… node --test --import tsx src/e2e.test.ts` (aggregate test) | **Not executed successfully** — Postgres unavailable; connection `ECONNREFUSED` |

Server integration and auth-matrix tests require a migrated database at the URL above. They were added but not green-verified in this environment.

## Work performed

Because the feature was absent, this stage implemented the approved contract and added the missing automated coverage:

- **Server:** `GET /api/projects/:id/artifacts` with pipeline-only rows, ordering, kinds, markdown excerpt cap, no `content`/`storageKey` in JSON.
- **Auth:** foreign-tenant matrix entry for the new route.
- **Integration test:** aggregate behavior, empty project, excerpt cap (in `e2e.test.ts`; needs DB to run).
- **API client:** `ProjectArtifactCard`, `listProjectArtifacts`.
- **Web:** `ArtifactsPage`, nav/routing between Board and Sessions, skeletons, styles, analytics hooks, drawer `artifact_opened` with `source: card_panel`.
- **Web tests:** route parsing, format/pluralization, skeleton tile count, posthog no-op safety, work-screen guard (artifacts does not load the board stream path in `App.tsx`).
- **Docs:** `docs/web-app.md` Artifacts section.

## Gaps and edge cases still weakly covered

| Area | Risk | Coverage today |
|------|------|----------------|
| Swarm artifacts | Must never appear on project grid | Query filters `type = 'pipeline'`; **no dedicated e2e** seeding a swarm row (DB required) |
| Stale project switch | Late `listProjectArtifacts` overwrites new project | Request gate in `ArtifactsPage`; **no async race test** |
| Image preview 404 | Should fall back to kind icon | Manual/browser; **no DOM test** for `onError` |
| Viewer focus return | a11y requirement | **Not automated** (modal focus trap in `ArtifactViewer` unchanged) |
| 200-artifact cap copy | Detail footnote | Render branch exists; **no test** with 200 rows |
| Query plan | `EXPLAIN (ANALYZE, BUFFERS)` before index | **Not run** (no DB) |
| Turbo parallel `pnpm test` | CI may differ | Flaky/cancelled suites under turbo in sandbox |
| Browser acceptance | Direct URLs, back/forward, mobile nav | **Not run** (no running stack) |

## Acceptance status

**Not fully verified.** Typecheck and build pass; web and api-client unit tests pass in isolation. Server e2e and full monorepo `pnpm test` were not fully green here due to missing Postgres and turbo parallelism issues. Manual browser acceptance and EXPLAIN remain outstanding before merge.

## Follow-up before merge

1. Start Postgres (`docker compose up -d postgres` or local equivalent), migrate, run `DATABASE_URL=postgres://postgres:postgres@localhost:5439/app pnpm --filter @bento/server test`.
2. Re-run root `pnpm test` in an environment where turbo package tests complete (or run packages sequentially).
3. Manual check: two cards, markdown/image/HTML artifacts, project switch, `/artifacts/:id`, viewer sandbox, 200-row notice.
4. `EXPLAIN (ANALYZE, BUFFERS)` on the aggregate query with realistic card counts.
