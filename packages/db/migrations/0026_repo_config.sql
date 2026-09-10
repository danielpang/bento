ALTER TABLE "projects" ADD COLUMN "repo_config_hash" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_config_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_config_error" text;