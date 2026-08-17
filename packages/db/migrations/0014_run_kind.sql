ALTER TABLE "agent_runs" ADD COLUMN "kind" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_runs_feature_queued_idx" ON "agent_runs" USING btree ("feature_id","queued_at");--> statement-breakpoint
CREATE INDEX "features_project_idx" ON "features" USING btree ("project_id");--> statement-breakpoint

-- Existing judge runs predate the column and are recognizable only by
-- the sentence their prompts open with, which is exactly the coupling
-- the column exists to end; this is the last time that text is load
-- bearing anywhere.
UPDATE "agent_runs" SET "kind" = 'judge' WHERE "prompt" LIKE 'You are the completion judge%';
