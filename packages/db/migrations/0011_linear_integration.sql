CREATE TABLE "linear_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"organization_id" text,
	"encrypted_api_key" text NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"webhook_id" text,
	"encrypted_webhook_secret" text,
	"default_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"feature_id" uuid NOT NULL,
	"linear_issue_id" text NOT NULL,
	"linear_issue_identifier" text NOT NULL,
	"linear_issue_url" text NOT NULL,
	"linear_team_id" text NOT NULL,
	"last_outbound_state_type" text,
	"last_inbound_updated_at" timestamp with time zone,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_issue_links_feature_id_unique" UNIQUE("feature_id")
);
--> statement-breakpoint
CREATE TABLE "linear_team_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"linear_team_id" text NOT NULL,
	"linear_team_key" text NOT NULL,
	"linear_team_name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linear_connections" ADD CONSTRAINT "linear_connections_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD CONSTRAINT "linear_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_connections" ADD CONSTRAINT "linear_connections_default_project_id_projects_id_fk" FOREIGN KEY ("default_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD CONSTRAINT "linear_issue_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_issue_links" ADD CONSTRAINT "linear_issue_links_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_team_mappings" ADD CONSTRAINT "linear_team_mappings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_team_mappings" ADD CONSTRAINT "linear_team_mappings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_connections_org_idx" ON "linear_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_connections_local_idx" ON "linear_connections" USING btree ((organization_id is null)) WHERE "linear_connections"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_links_org_issue_idx" ON "linear_issue_links" USING btree ("organization_id","linear_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_issue_links_local_issue_idx" ON "linear_issue_links" USING btree ("linear_issue_id") WHERE "linear_issue_links"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "linear_team_mappings_org_team_idx" ON "linear_team_mappings" USING btree ("organization_id","linear_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_team_mappings_local_team_idx" ON "linear_team_mappings" USING btree ("linear_team_id") WHERE "linear_team_mappings"."organization_id" is null;
-- Tenant plumbing for the Linear tables: inherit organization from the
-- parent row on insert, and confine every query to the caller's org.
CREATE TRIGGER linear_team_mappings_inherit_org BEFORE INSERT ON linear_team_mappings
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('projects', 'project_id');--> statement-breakpoint
CREATE TRIGGER linear_issue_links_inherit_org BEFORE INSERT ON linear_issue_links
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('features', 'feature_id');--> statement-breakpoint

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'linear_connections', 'linear_team_mappings', 'linear_issue_links'
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
