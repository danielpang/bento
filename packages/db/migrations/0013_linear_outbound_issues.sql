ALTER TABLE "linear_connections" ADD COLUMN "create_issues" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD COLUMN "default_team_id" text;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD COLUMN "default_team_key" text;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD COLUMN "default_team_name" text;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD COLUMN "default_linear_project_id" text;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD COLUMN "default_linear_project_name" text;