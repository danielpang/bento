CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text DEFAULT '' NOT NULL,
	"last_used_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_token_idx" ON "mcp_connections" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_connections_org_idx" ON "mcp_connections" USING btree ("organization_id");--> statement-breakpoint
-- Tenant plumbing. mcp_connections is parented by the organization
-- itself, whose id is text, and bento_inherit_org casts the parent id
-- to uuid, so the routes set organization_id explicitly (the secrets
-- and mcp_servers precedent).
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE mcp_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY mcp_connections_org_isolation ON mcp_connections
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint
-- Default privileges grant DML on every new public table, so a GRANT
-- alone leaves UPDATE in place: it has to be taken back by name.
-- The management routes create, list, and delete connections on the
-- tenant path. UPDATE stays off it: the only updates are the usage
-- counters, written by the MCP endpoint on the owner pool, and a
-- tenant-path bug must not be able to rewrite a token hash or widen a
-- stored scope.
REVOKE UPDATE ON mcp_connections FROM bento_user;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON mcp_connections TO bento_user;
