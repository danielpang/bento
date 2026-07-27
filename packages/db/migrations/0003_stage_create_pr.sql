ALTER TABLE "stages" ADD COLUMN "create_pr" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Stages already gating on the pull request were relying on publishing
-- happening implicitly; keep them working now that it is opt-in.
UPDATE "stages" SET "create_pr" = true
WHERE "gate_criteria"::text LIKE '%pr_comments_resolved%'
   OR "gate_criteria"::text LIKE '%checks_pass%';
