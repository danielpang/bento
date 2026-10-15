# Implementation

The board's existing feature list endpoint now omits cards whose latest relevant completion is outside the last 14 days. `GET /api/features?projectId=<id>` still accepts the same required project ID and returns the same `Feature[]` payload, so the web app and API client need no contract changes.

The filter lives in `apps/server/src/routes/features.ts`. All unfinished and cancelled cards remain in the response. A card with status `done` is returned only when its `feature_events` history contains a `status_changed` event to `done` at or after the database clock's `now() - interval '14 days'`. This also handles a card completed more than once: a recent completion keeps it visible even when an older completion exists.

No new data or migration is required. The existing `features` and `feature_events` tables remain the source of truth, and migration `0022_feature_events_completions_idx.sql` already provides the partial `(feature_id, at)` index used by completion lookups. `features.updated_at` was deliberately not used because unrelated edits can change it after completion.

The database-backed server test covers active cards, recent and old completions, repeated completions, and cancelled cards. Verification completed with the targeted PostgreSQL integration test, the full workspace type check, and the full production build.

Risk is limited to historical `done` rows without a matching completion event: they are treated as having no recent completion and are hidden. That is consistent with the existing completions reporting path, which already treats `feature_events` as the authoritative completion record. The change is reversible by removing the list predicate and has no destructive migration or data rewrite.
