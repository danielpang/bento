-- The last model list fetched from models.dev and the AI Gateway.
-- One row, the same for every organization, so it is not a tenant
-- table and has no row-level security. The public catalog route
-- already serves this list. Requests run as bento_user and may read
-- it; only the server process, which owns the table, writes it.
CREATE TABLE "model_catalog_snapshots" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"generated" jsonb NOT NULL,
	"gateway" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_snapshots_singleton" CHECK ("id" = 'current')
);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON model_catalog_snapshots FROM bento_user;
--> statement-breakpoint
GRANT SELECT ON model_catalog_snapshots TO bento_user;
