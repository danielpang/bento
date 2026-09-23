ALTER TABLE "slack_thread_links" DROP CONSTRAINT "slack_thread_links_feature_id_unique";--> statement-breakpoint
DROP INDEX "slack_thread_links_org_feature_idx";--> statement-breakpoint
DROP INDEX "slack_thread_links_local_feature_idx";--> statement-breakpoint
ALTER TABLE "slack_thread_links" ALTER COLUMN "feature_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_thread_links" ADD COLUMN "swarm_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_org_swarm_idx" ON "slack_thread_links" USING btree ("organization_id","swarm_id") WHERE "slack_thread_links"."swarm_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_local_swarm_idx" ON "slack_thread_links" USING btree ("swarm_id") WHERE "slack_thread_links"."organization_id" is null AND "slack_thread_links"."swarm_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_org_feature_idx" ON "slack_thread_links" USING btree ("organization_id","feature_id") WHERE "slack_thread_links"."feature_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_thread_links_local_feature_idx" ON "slack_thread_links" USING btree ("feature_id") WHERE "slack_thread_links"."organization_id" is null AND "slack_thread_links"."feature_id" is not null;--> statement-breakpoint
ALTER TABLE "slack_thread_links" ADD CONSTRAINT "slack_thread_links_owner_shape" CHECK (("slack_thread_links"."feature_id" is null) <> ("slack_thread_links"."swarm_id" is null));
--> statement-breakpoint
DROP TRIGGER slack_thread_links_inherit_org ON slack_thread_links;
--> statement-breakpoint
CREATE TRIGGER slack_thread_links_inherit_org BEFORE INSERT ON slack_thread_links
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org_any('features', 'feature_id', 'swarms', 'swarm_id');
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'slack_thread_links'
      AND column_name = 'swarm_id'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'slack_thread_links_owner_shape'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'slack_thread_links_inherit_org'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0039_swarm_slack_threads did not install its owner shape and tenant trigger';
  END IF;
END $$;
