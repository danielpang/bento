-- One machine, one row.
--
-- run-executor's insert says `onConflictDoNothing()` and falls back to
-- selecting the row it assumes already exists, but there was no unique
-- index for that conflict to fire on, so every run inserted another row
-- naming the same machine. The index below makes the code mean what it
-- says. Existing duplicates have to go first, or creating it fails.
--
-- Runs are repointed before anything is deleted: agent_runs.sandbox_id
-- is ON DELETE NO ACTION, so removing a row a run still references
-- would abort the migration rather than orphan the run.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY external_id ORDER BY created_at DESC, id DESC
    ) AS keep_id
  FROM sandboxes
)
UPDATE agent_runs r
SET sandbox_id = ranked.keep_id
FROM ranked
WHERE r.sandbox_id = ranked.id
  AND ranked.id <> ranked.keep_id;
--> statement-breakpoint
-- The newest row survives: it carries the most recent status and the
-- size column, which only later provisions ever wrote.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY external_id ORDER BY created_at DESC, id DESC
    ) AS keep_id
  FROM sandboxes
)
DELETE FROM sandboxes s
USING ranked
WHERE s.id = ranked.id
  AND ranked.id <> ranked.keep_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_external_id_idx" ON "sandboxes" USING btree ("external_id");
