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
ALTER TABLE "mcp_connections" ADD COLUMN "refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_requests" ADD CONSTRAINT "mcp_oauth_requests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_clients_client_idx" ON "mcp_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_codes_hash_idx" ON "mcp_oauth_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_codes_expires_idx" ON "mcp_oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_requests_expires_idx" ON "mcp_oauth_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_refresh_idx" ON "mcp_connections" USING btree ("refresh_token_hash");
--> statement-breakpoint
-- Authorization codes inherit the connection's organization and sit
-- behind RLS, the mcp_run_grants shape. The token endpoint exchanges
-- them on the owner pool; bento_user may SELECT (the structural tests
-- read every tenant table) but must not mint or rewrite a code.
ALTER TABLE mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mcp_oauth_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY mcp_oauth_codes_org_isolation ON mcp_oauth_codes
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());
--> statement-breakpoint
CREATE TRIGGER mcp_oauth_codes_inherit_org BEFORE INSERT ON mcp_oauth_codes
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('mcp_connections', 'connection_id');
--> statement-breakpoint
-- Default privileges grant DML on every new public table. Codes are
-- minted only on the owner pool, the mcp_run_grants shape: the tenant
-- role may SELECT (structural RLS tests) but must not insert or rewrite
-- an authorization code.
REVOKE INSERT, UPDATE, DELETE ON mcp_oauth_codes FROM bento_user;
--> statement-breakpoint
GRANT SELECT ON mcp_oauth_codes TO bento_user;
