ALTER TABLE "repositories" ADD COLUMN "setup_command" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "test_command" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "setup_fingerprint" text;