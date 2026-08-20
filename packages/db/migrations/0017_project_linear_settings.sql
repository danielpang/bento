ALTER TABLE "projects" ADD COLUMN "linear_create_issues" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "linear_team_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "linear_team_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "linear_team_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "linear_project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "linear_project_name" text;--> statement-breakpoint
UPDATE "projects" SET
  "linear_create_issues" = lc."create_issues",
  "linear_team_id" = lc."default_team_id",
  "linear_team_key" = lc."default_team_key",
  "linear_team_name" = lc."default_team_name",
  "linear_project_id" = lc."default_linear_project_id",
  "linear_project_name" = lc."default_linear_project_name"
FROM "linear_connections" lc
WHERE "projects"."organization_id" = lc."organization_id"
   OR ("projects"."organization_id" IS NULL AND lc."organization_id" IS NULL);--> statement-breakpoint
ALTER TABLE "linear_connections" DROP COLUMN "create_issues";--> statement-breakpoint
ALTER TABLE "linear_connections" DROP COLUMN "default_team_id";--> statement-breakpoint
ALTER TABLE "linear_connections" DROP COLUMN "default_team_key";--> statement-breakpoint
ALTER TABLE "linear_connections" DROP COLUMN "default_team_name";--> statement-breakpoint
ALTER TABLE "linear_connections" DROP COLUMN "default_linear_project_id";--> statement-breakpoint
ALTER TABLE "linear_connections" DROP COLUMN "default_linear_project_name";