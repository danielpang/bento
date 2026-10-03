-- A plan a person already has, handed to a swarm when it starts.
--
-- Two things. A column on swarms saying where the plan comes from, and
-- a table holding what the person uploaded or had fetched. The table is
-- a tenant table and gets the whole of the isolation machinery here:
-- row-level security enabled and forced, the organization policy, the
-- trigger that derives organization_id from the swarm, and the grant to
-- the request role. None of it is inherited, so none of it is left to
-- a later migration.

-- Where the plan comes from. 'goal' is what every swarm so far did:
-- the planner read the goal and the code and wrote the plan itself.
-- 'existing' says the person already has one and the planner's job is
-- to turn it into the task tree.
ALTER TABLE "swarms" ADD COLUMN "plan_mode" text DEFAULT 'goal' NOT NULL;--> statement-breakpoint

CREATE TABLE "swarm_plan_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"organization_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swarm_plan_sources" ADD CONSTRAINT "swarm_plan_sources_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_plan_sources" ADD CONSTRAINT "swarm_plan_sources_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swarm_plan_sources_swarm_idx" ON "swarm_plan_sources" USING btree ("swarm_id","position");--> statement-breakpoint

-- The tenant is derived from the swarm on insert, so no insert can
-- forget to tag it.
CREATE TRIGGER swarm_plan_sources_inherit_org BEFORE INSERT ON swarm_plan_sources
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('swarms', 'swarm_id');--> statement-breakpoint

ALTER TABLE swarm_plan_sources ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE swarm_plan_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY swarm_plan_sources_org_isolation ON swarm_plan_sources
  USING (organization_id IS NOT DISTINCT FROM bento_current_org())
  WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON swarm_plan_sources TO bento_user;
