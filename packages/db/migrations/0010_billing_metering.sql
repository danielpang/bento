ALTER TABLE "agent_runs" ADD COLUMN "started_by" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "size" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "identity"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- One machine, one row. run-executor's insert says onConflictDoNothing
-- and there was nothing for the conflict to fire on, so every run
-- inserted another row naming the same machine. Existing duplicates
-- have to go before the index can exist, and runs are repointed first:
-- agent_runs.sandbox_id is ON DELETE NO ACTION, so deleting a row a
-- run still references would abort this migration.
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
  AND ranked.id <> ranked.keep_id;--> statement-breakpoint
-- The newest row survives: it carries the most recent status, and the
-- size column only later provisions ever wrote.
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
  AND ranked.id <> ranked.keep_id;--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_external_id_idx" ON "sandboxes" USING btree ("external_id");
