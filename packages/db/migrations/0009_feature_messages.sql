CREATE TABLE "feature_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_id" uuid NOT NULL,
	"organization_id" text,
	"text" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "feature_messages" ADD CONSTRAINT "feature_messages_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_messages" ADD CONSTRAINT "feature_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_messages" ADD CONSTRAINT "feature_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_messages_claim_idx" ON "feature_messages" USING btree ("feature_id","status","created_at");--> statement-breakpoint
CREATE TRIGGER feature_messages_inherit_org BEFORE INSERT ON feature_messages
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('features', 'feature_id');--> statement-breakpoint
ALTER TABLE feature_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE feature_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY feature_messages_org_isolation ON feature_messages USING (organization_id IS NOT DISTINCT FROM bento_current_org()) WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_messages TO bento_user;--> statement-breakpoint
INSERT INTO feature_messages (feature_id, organization_id, text, created_at)
SELECT f.id, f.organization_id, line.value, now() + make_interval(secs => line.ord * 0.001)
FROM features f, LATERAL unnest(string_to_array(f.queued_prompt, E'\n')) WITH ORDINALITY AS line(value, ord)
WHERE f.queued_prompt IS NOT NULL AND length(trim(line.value)) > 0;--> statement-breakpoint
ALTER TABLE "features" DROP COLUMN "queued_prompt";
