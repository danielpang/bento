CREATE TABLE "slack_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"organization_id" text,
	"slack_team_id" text NOT NULL,
	"slack_team_name" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"encrypted_bot_token" text NOT NULL,
	"installed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"user_id" text NOT NULL,
	"slack_user_id" text,
	"default_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_thread_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"feature_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"review_message_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_thread_links_feature_id_unique" UNIQUE("feature_id")
);
--> statement-breakpoint
CREATE TABLE "slack_pending_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_settings" ADD CONSTRAINT "slack_user_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_settings" ADD CONSTRAINT "slack_user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_settings" ADD CONSTRAINT "slack_user_settings_default_project_id_projects_id_fk" FOREIGN KEY ("default_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_pending_mentions" ADD CONSTRAINT "slack_pending_mentions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connections_org_idx" ON "slack_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connections_local_idx" ON "slack_connections" USING btree ((organization_id is null)) WHERE "slack_connections"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_connections_team_idx" ON "slack_connections" USING btree ("slack_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_settings_org_user_idx" ON "slack_user_settings" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_settings_local_user_idx" ON "slack_user_settings" USING btree ("user_id") WHERE "slack_user_settings"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_settings_org_slack_user_idx" ON "slack_user_settings" USING btree ("organization_id","slack_user_id") WHERE "slack_user_settings"."slack_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_settings_local_slack_user_idx" ON "slack_user_settings" USING btree ("slack_user_id") WHERE "slack_user_settings"."organization_id" is null AND "slack_user_settings"."slack_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_org_feature_idx" ON "slack_thread_links" USING btree ("organization_id","feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_local_feature_idx" ON "slack_thread_links" USING btree ("feature_id") WHERE "slack_thread_links"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_thread_idx" ON "slack_thread_links" USING btree ("slack_team_id","slack_channel_id","slack_thread_ts");--> statement-breakpoint
CREATE INDEX "slack_pending_mentions_expires_idx" ON "slack_pending_mentions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_pending_mentions_thread_idx" ON "slack_pending_mentions" USING btree ("slack_team_id","slack_channel_id","slack_thread_ts");
--> statement-breakpoint
-- Tenant plumbing: inherit organization from the parent card on
-- thread links, and confine every Slack table to the caller's org.
CREATE TRIGGER slack_thread_links_inherit_org BEFORE INSERT ON slack_thread_links
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('features', 'feature_id');--> statement-breakpoint

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'slack_connections', 'slack_user_settings', 'slack_thread_links', 'slack_pending_mentions'
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
