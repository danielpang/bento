ALTER TABLE "organization_policies" ADD COLUMN "pipeline_seed" jsonb;--> statement-breakpoint
ALTER TABLE "organization_policies" ADD COLUMN "setup_completed_at" timestamp with time zone;
