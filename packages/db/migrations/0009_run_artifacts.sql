CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"organization_id" text,
	"stage_slug" text NOT NULL,
	"stage_name" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"content" text,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_artifacts_content_or_key" CHECK (("run_artifacts"."content" is null) <> ("run_artifacts"."storage_key" is null))
);
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_artifacts_feature_idx" ON "run_artifacts" USING btree ("feature_id","created_at");--> statement-breakpoint
CREATE INDEX "run_artifacts_run_idx" ON "run_artifacts" USING btree ("run_id");--> statement-breakpoint

-- Tenant isolation, none of which a new table inherits: the policy, the
-- FORCE, and the inherit trigger each have to be stated here, and
-- rls.test.ts lists this table so forgetting one fails loudly.
ALTER TABLE "run_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "run_artifacts_org_isolation" ON "run_artifacts"
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint
CREATE TRIGGER run_artifacts_inherit_org BEFORE INSERT ON run_artifacts
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('agent_runs', 'run_id');