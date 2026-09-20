CREATE TABLE "pull_request_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"organization_id" text,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"body" text DEFAULT '' NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_request_updates" ADD CONSTRAINT "pull_request_updates_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_updates" ADD CONSTRAINT "pull_request_updates_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_updates" ADD CONSTRAINT "pull_request_updates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pull_request_updates_feature_idx" ON "pull_request_updates" USING btree ("feature_id","branch","applied_at");--> statement-breakpoint
CREATE INDEX "pull_request_updates_run_idx" ON "pull_request_updates" USING btree ("run_id");--> statement-breakpoint

-- Tenant isolation, none of which a new table inherits: the policy, the
-- FORCE, and the inherit trigger each have to be stated here, and
-- rls.test.ts lists this table so forgetting one fails loudly.
ALTER TABLE "pull_request_updates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pull_request_updates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pull_request_updates_org_isolation" ON "pull_request_updates"
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint
CREATE TRIGGER pull_request_updates_inherit_org BEFORE INSERT ON pull_request_updates
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('agent_runs', 'run_id');
