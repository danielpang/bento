CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text DEFAULT '' NOT NULL,
	"refresh_token_hash" text,
	"oauth_client_id" text,
	"last_used_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"client_name" text DEFAULT '' NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"organization_id" text,
	"token_bundle" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_requests" ADD CONSTRAINT "mcp_oauth_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_token_idx" ON "mcp_connections" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_refresh_idx" ON "mcp_connections" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "mcp_connections_org_idx" ON "mcp_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_clients_client_idx" ON "mcp_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_codes_hash_idx" ON "mcp_oauth_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_codes_expires_idx" ON "mcp_oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_requests_expires_idx" ON "mcp_oauth_requests" USING btree ("expires_at");--> statement-breakpoint
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
GRANT SELECT, INSERT, DELETE ON mcp_connections TO bento_user;--> statement-breakpoint
-- Authorization codes inherit the connection's organization and sit
-- behind RLS, the mcp_run_grants shape. The token endpoint exchanges
-- them on the owner pool; bento_user may SELECT (the structural tests
-- read every tenant table) but must not mint or rewrite a code.
ALTER TABLE mcp_oauth_codes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE mcp_oauth_codes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY mcp_oauth_codes_org_isolation ON mcp_oauth_codes
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint
CREATE TRIGGER mcp_oauth_codes_inherit_org BEFORE INSERT ON mcp_oauth_codes
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('mcp_connections', 'connection_id');--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON mcp_oauth_codes FROM bento_user;--> statement-breakpoint
GRANT SELECT ON mcp_oauth_codes TO bento_user;--> statement-breakpoint
-- mcp_oauth_requests and mcp_oauth_clients are not tenant rows: a
-- pending authorization exists before anyone has signed in, so it has
-- no organization to key a policy on, and a client registration is
-- global. Row-level security therefore has nothing to say about them,
-- and least privilege is the whole protection: both are written only
-- by the OAuth routes on the owner pool, so the tenant role keeps
-- SELECT and loses the rest. Without this a tenant-path bug could
-- rewrite a pending request's redirect_uri and steer the resulting
-- authorization code somewhere else.
REVOKE INSERT, UPDATE, DELETE ON mcp_oauth_requests FROM bento_user;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON mcp_oauth_clients FROM bento_user;--> statement-breakpoint
GRANT SELECT ON mcp_oauth_requests, mcp_oauth_clients TO bento_user;
