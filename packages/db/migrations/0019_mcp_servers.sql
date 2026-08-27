CREATE TABLE "mcp_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"organization_id" text,
	"user_id" text,
	"kind" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"token_endpoint_origin" text,
	"hint" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_run_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" text,
	"acting_user_id" text,
	"token_hash" text NOT NULL,
	"server_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"auth_type" text NOT NULL,
	"credential_scope" text DEFAULT 'org' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"api_key_header" text DEFAULT 'Authorization' NOT NULL,
	"client_id" text,
	"encrypted_client_secret" text,
	"client_registration" text,
	"authorization_endpoint" text,
	"token_endpoint" text,
	"registration_endpoint" text,
	"issuer" text,
	"resource" text,
	"scopes" text,
	"metadata_discovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_messages" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_acting_user_id_user_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "identity"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_server_user_idx" ON "mcp_credentials" USING btree ("server_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_server_org_idx" ON "mcp_credentials" USING btree ("server_id") WHERE "mcp_credentials"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_run_grants_run_idx" ON "mcp_run_grants" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_run_grants_token_idx" ON "mcp_run_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_run_grants_expires_idx" ON "mcp_run_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_org_slug_idx" ON "mcp_servers" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_local_slug_idx" ON "mcp_servers" USING btree ("slug") WHERE "mcp_servers"."organization_id" is null;--> statement-breakpoint
ALTER TABLE "feature_messages" ADD CONSTRAINT "feature_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Tenant plumbing. mcp_servers is parented by the organization itself,
-- whose id is text, and bento_inherit_org casts the parent id to uuid,
-- so the routes set organization_id explicitly (the secrets precedent).
-- The two children inherit from uuid-keyed parents and get triggers.
CREATE TRIGGER mcp_credentials_inherit_org BEFORE INSERT ON mcp_credentials
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('mcp_servers', 'server_id');--> statement-breakpoint
CREATE TRIGGER mcp_run_grants_inherit_org BEFORE INSERT ON mcp_run_grants
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('agent_runs', 'run_id');--> statement-breakpoint

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'mcp_servers', 'mcp_credentials', 'mcp_run_grants'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id IS NOT DISTINCT FROM bento_current_org()) WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org())',
      table_name || '_org_isolation',
      table_name
    );
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_servers, mcp_credentials TO bento_user;--> statement-breakpoint
-- Run grants are minted, extended, revoked, and swept only by
-- orchestrator code on the owner pool; no tenant-path route writes
-- them. The tenant role keeps SELECT (the RLS structural tests read
-- every tenant table) but loses DML: a future tenant-path bug must not
-- be able to extend or forge its own agent's grant.
REVOKE INSERT, UPDATE, DELETE ON mcp_run_grants FROM bento_user;--> statement-breakpoint
GRANT SELECT ON mcp_run_grants TO bento_user;