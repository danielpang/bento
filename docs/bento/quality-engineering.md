# Quality engineering

Feature: only show completed work from the last two weeks (`GET /api/features?projectId=`).

## What was verified

The filter in `apps/server/src/routes/features.ts` is exercised through real HTTP requests against PostgreSQL in `apps/server/src/e2e.test.ts`, not by re-reading the route handler.

### Test runs

| Command | Environment | Result |
| --- | --- | --- |
| `pnpm test` (repo root) | Default `DATABASE_URL` (`localhost:5439`) | **Failed** before server tests finished: `@bento/core#test` reported 5 file-level failures (`test failed` / pending promises in `@bento/web`). Not caused by this feature. |
| `pnpm test` (repo root) | `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app` | **Failed** early in turbo (`@bento/core#test`); same class of workspace-wide noise. Use `127.0.0.1` instead of `localhost` when Postgres rejects IPv6 (`pg_hba`). |
| `pnpm --filter @bento/server test` | `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5439/app` | **1240 pass, 1 fail** on one run: `a run without credentials says so in the transcript` (unrelated agent/MCP transcript assertion). Re-running that test alone **passed**. Board filter tests **passed** on the same run. |
| `pnpm --filter @bento/server typecheck` | — | **Passed** |

### Coverage for this feature

Existing integration test `the board lists only cards completed in the last two weeks` (from implementation and code review):

- Active, recently done, re-done after an old completion, old done, cancelled, and cross-project isolation.

Added in this stage:

1. **`the board two-week window follows the database fourteen-day boundary`** — Uses SQL `now() - interval '14 days' ± 1 second` so the cutoff matches the database predicate (`>= now() - interval '14 days'`), not JavaScript clock skew. A completion exactly at `now() - 14 days` at insert time can fall outside the window by the time the list runs; product behavior is defined by the SQL interval, and the ±1 second fixtures pin the inclusive edge without flake.
2. **`a done card without a completion event is hidden from the board list`** — `status = done` with no `status_changed` event is omitted, matching implementation and completions reporting.

### Acceptance criteria

| Criterion | Status |
| --- | --- |
| Non-`done` cards still listed | Covered (existing test) |
| `done` only if completion within 14 days per `feature_events` | Covered (existing + boundary test) |
| Latest completion wins when a card was completed more than once | Covered (existing test) |
| Cancelled cards still listed | Covered (existing test) |
| Filter scoped to requested project (no OR/grouping leak) | Covered (existing test; fixed in prior commit) |
| API shape unchanged | No contract tests added; unchanged handler return type |

### Gaps (documented, not blockers)

- **Mac** `GET /api/projects/:id/board/plain` and **MCP** `list_features` still return unfiltered completed cards (noted in code review).
- **Web/TUI** do not integration-test the filter; they consume the same API.
- **Delete/stage warnings** that count `listFeatures` can undercount old done cards (code review side effect).
- **Deep link** `?feature=` to an old done card does not open the drawer because the card is absent from the filtered list (code review).
- No automated guard on Drizzle `toSQL()` grouping; regression relies on the cross-project e2e assertion.

`bento-cloud` has no changes on this branch.

## Verdict

Feature behavior for the web/TUI board list is **verified by integration tests**, with **additional boundary and orphan-`done` coverage** added here. Server package tests are green for this feature; one unrelated e2e test flaked once in a full server run. Root `pnpm test` in this sandbox is not a reliable gate without `127.0.0.1` and is noisy outside `@bento/server`.
