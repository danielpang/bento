CREATE TABLE "swarm_landings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"organization_id" text,
	"task_id" uuid NOT NULL,
	"branch_name" text,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"resolver_run_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"organization_id" text,
	"task_id" uuid,
	"text" text NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "swarm_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"repository_id" uuid,
	"organization_id" text,
	"repo_url" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"head_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"organization_id" text,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"run_id" uuid,
	"actor_user_id" text,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"organization_id" text,
	"parent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attention" text,
	"weight" integer DEFAULT 1 NOT NULL,
	"branch_name" text,
	"assigned_run_id" uuid,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report" text,
	"cost_measured_usd" numeric DEFAULT '0' NOT NULL,
	"cost_estimated_usd" numeric DEFAULT '0' NOT NULL,
	"cost_assumed_usd" numeric DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"planner_profile_id" uuid,
	"worker_profile_id" uuid,
	"planner_instructions" text,
	"worker_instructions" text,
	"max_workers" integer DEFAULT 4 NOT NULL,
	"budget_usd" numeric,
	"time_limit_min" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"template_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"paused_reason" text,
	"branch_name" text,
	"sandbox_id" uuid,
	"budget_usd" numeric,
	"max_workers" integer DEFAULT 4 NOT NULL,
	"time_limit_min" integer,
	"spent_measured_usd" numeric DEFAULT '0' NOT NULL,
	"spent_estimated_usd" numeric DEFAULT '0' NOT NULL,
	"spent_assumed_usd" numeric DEFAULT '0' NOT NULL,
	"started_by" text,
	"archived_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "feature_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "stage_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_artifacts" ALTER COLUMN "feature_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "swarm_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "swarm_task_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "role" text DEFAULT 'stage' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD COLUMN "swarm_id" uuid;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD COLUMN "swarm_id" uuid;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD COLUMN "swarm_task_id" uuid;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "swarm_id" uuid;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "swarm_task_id" uuid;--> statement-breakpoint
ALTER TABLE "swarm_landings" ADD CONSTRAINT "swarm_landings_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_landings" ADD CONSTRAINT "swarm_landings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_landings" ADD CONSTRAINT "swarm_landings_task_id_swarm_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_landings" ADD CONSTRAINT "swarm_landings_resolver_run_id_agent_runs_id_fk" FOREIGN KEY ("resolver_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_task_id_swarm_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_messages" ADD CONSTRAINT "swarm_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_pull_requests" ADD CONSTRAINT "swarm_pull_requests_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_pull_requests" ADD CONSTRAINT "swarm_pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_pull_requests" ADD CONSTRAINT "swarm_pull_requests_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_task_events" ADD CONSTRAINT "swarm_task_events_task_id_swarm_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_task_events" ADD CONSTRAINT "swarm_task_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_task_events" ADD CONSTRAINT "swarm_task_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_task_events" ADD CONSTRAINT "swarm_task_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_parent_id_swarm_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_assigned_run_id_agent_runs_id_fk" FOREIGN KEY ("assigned_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD CONSTRAINT "swarm_templates_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "identity"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD CONSTRAINT "swarm_templates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD CONSTRAINT "swarm_templates_planner_profile_id_agent_profiles_id_fk" FOREIGN KEY ("planner_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD CONSTRAINT "swarm_templates_worker_profile_id_agent_profiles_id_fk" FOREIGN KEY ("worker_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_template_id_swarm_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."swarm_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "identity"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swarm_landings_queue_idx" ON "swarm_landings" USING btree ("swarm_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "swarm_landings_one_in_flight_idx" ON "swarm_landings" USING btree ("swarm_id") WHERE "swarm_landings"."status" = 'landing';--> statement-breakpoint
CREATE INDEX "swarm_messages_claim_idx" ON "swarm_messages" USING btree ("swarm_id","task_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "swarm_pull_requests_swarm_repo_idx" ON "swarm_pull_requests" USING btree ("swarm_id","repo_url");--> statement-breakpoint
CREATE INDEX "swarm_task_events_task_at_idx" ON "swarm_task_events" USING btree ("task_id","at");--> statement-breakpoint
CREATE INDEX "swarm_tasks_tree_idx" ON "swarm_tasks" USING btree ("swarm_id","parent_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "swarms_project_slug_idx" ON "swarms" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "swarms_project_idx" ON "swarms" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_swarm_task_id_swarm_tasks_id_fk" FOREIGN KEY ("swarm_task_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_run_grants" ADD CONSTRAINT "mcp_run_grants_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_swarm_task_id_swarm_tasks_id_fk" FOREIGN KEY ("swarm_task_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_swarm_task_id_swarm_tasks_id_fk" FOREIGN KEY ("swarm_task_id") REFERENCES "public"."swarm_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_swarm_queued_idx" ON "agent_runs" USING btree ("swarm_id","queued_at");--> statement-breakpoint
CREATE INDEX "run_artifacts_swarm_idx" ON "run_artifacts" USING btree ("swarm_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_feature_or_swarm" CHECK (("agent_runs"."feature_id" is null) <> ("agent_runs"."swarm_id" is null));--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_feature_or_swarm" CHECK (("run_artifacts"."feature_id" is null) <> ("run_artifacts"."swarm_id" is null));--> statement-breakpoint

-- Tenant isolation, none of which a new table inherits: the ENABLE, the
-- FORCE, the policy, and the inherit trigger each have to be stated
-- here, and rls.test.ts lists all seven so forgetting one fails loudly.
--
-- swarm_templates has no parent row to inherit from. It is keyed by its
-- owner the way agent_profiles and mcp_servers are, and its routes set
-- organization_id explicitly; RLS still checks what they set.
CREATE TRIGGER swarms_inherit_org BEFORE INSERT ON swarms
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('projects', 'project_id');--> statement-breakpoint
CREATE TRIGGER swarm_tasks_inherit_org BEFORE INSERT ON swarm_tasks
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('swarms', 'swarm_id');--> statement-breakpoint
CREATE TRIGGER swarm_task_events_inherit_org BEFORE INSERT ON swarm_task_events
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('swarm_tasks', 'task_id');--> statement-breakpoint
CREATE TRIGGER swarm_landings_inherit_org BEFORE INSERT ON swarm_landings
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('swarms', 'swarm_id');--> statement-breakpoint
CREATE TRIGGER swarm_pull_requests_inherit_org BEFORE INSERT ON swarm_pull_requests
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('swarms', 'swarm_id');--> statement-breakpoint
CREATE TRIGGER swarm_messages_inherit_org BEFORE INSERT ON swarm_messages
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('swarms', 'swarm_id');--> statement-breakpoint

DO $$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'swarm_templates', 'swarms', 'swarm_tasks', 'swarm_task_events',
    'swarm_landings', 'swarm_pull_requests', 'swarm_messages'
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

-- A run now hangs off a card or off a swarm, so it can no longer
-- inherit its organization from one fixed parent. This walks the
-- (table, column) pairs in order and derives from the first one the row
-- actually sets, which is the same rule the check constraint states:
-- exactly one of them is there.
CREATE FUNCTION bento_inherit_org_any() RETURNS trigger AS $$
DECLARE
  i int := 0;
  parent_id text;
  derived_org_id text;
BEGIN
  IF NEW.organization_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  WHILE i < TG_NARGS LOOP
    EXECUTE format('SELECT ($1).%I::text', TG_ARGV[i + 1])
      INTO parent_id USING NEW;
    IF parent_id IS NOT NULL THEN
      EXECUTE format('SELECT organization_id FROM %I WHERE id = $1::uuid', TG_ARGV[i])
        INTO derived_org_id USING parent_id;
      NEW.organization_id := derived_org_id;
      RETURN NEW;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER agent_runs_inherit_org ON agent_runs;--> statement-breakpoint
CREATE TRIGGER agent_runs_inherit_org BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION bento_inherit_org_any('features', 'feature_id', 'swarms', 'swarm_id');--> statement-breakpoint

-- run_artifacts keeps inheriting from its run: run_id is NOT NULL
-- there, and the run already carries whichever board's organization.

-- The run tenant check, generalized to both boards.
--
-- The old body dereferenced feature_id and stage_id unconditionally. A
-- swarm run has neither, so every lookup came back null: in multi mode
-- the run's own organization_id was the swarm's, IS DISTINCT FROM was
-- true, and the insert was refused. In local mode every value involved
-- is null, nothing is distinct, and the identical insert succeeded, so
-- a suite exercised only locally would have gone green while multi mode
-- could not start a single swarm agent. A swarm run is now validated
-- against its swarm, its task and its profile the way a card run is
-- validated against its feature, its stage and its profile.
CREATE OR REPLACE FUNCTION bento_validate_run_tenant() RETURNS trigger AS $$
DECLARE
  feature_org text;
  feature_pipeline uuid;
  stage_org text;
  stage_pipeline uuid;
  profile_org text;
  swarm_org text;
  task_org text;
  task_swarm uuid;
BEGIN
  SELECT organization_id
    INTO profile_org
    FROM agent_profiles WHERE id = NEW.agent_profile_id;

  IF NEW.swarm_id IS NOT NULL THEN
    SELECT organization_id INTO swarm_org FROM swarms WHERE id = NEW.swarm_id;
    IF NEW.swarm_task_id IS NOT NULL THEN
      SELECT organization_id, swarm_id
        INTO task_org, task_swarm
        FROM swarm_tasks WHERE id = NEW.swarm_task_id;
      IF task_swarm IS DISTINCT FROM NEW.swarm_id
        OR task_org IS DISTINCT FROM swarm_org
      THEN
        RAISE EXCEPTION 'agent run references cross an organization or swarm boundary';
      END IF;
    END IF;
    IF NEW.organization_id IS DISTINCT FROM swarm_org
      OR profile_org IS DISTINCT FROM swarm_org
    THEN
      RAISE EXCEPTION 'agent run references cross an organization or swarm boundary';
    END IF;
    RETURN NEW;
  END IF;

  -- A card run. stage_id lost its NOT NULL so a swarm run could leave
  -- it empty, so the pipeline's own requirement is stated here instead.
  IF NEW.stage_id IS NULL THEN
    RAISE EXCEPTION 'a pipeline agent run must name its stage';
  END IF;

  SELECT organization_id, pipeline_id
    INTO feature_org, feature_pipeline
    FROM features WHERE id = NEW.feature_id;
  SELECT organization_id, pipeline_id
    INTO stage_org, stage_pipeline
    FROM stages WHERE id = NEW.stage_id;

  IF NEW.organization_id IS DISTINCT FROM feature_org
    OR stage_org IS DISTINCT FROM feature_org
    OR profile_org IS DISTINCT FROM feature_org
    OR stage_pipeline IS DISTINCT FROM feature_pipeline
  THEN
    RAISE EXCEPTION 'agent run references cross an organization or pipeline boundary';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The swarm columns join the update list: repointing a run at another
-- tenant's swarm has to be refused the same way repointing it at their
-- stage is.
DROP TRIGGER agent_runs_validate_tenant ON agent_runs;--> statement-breakpoint
CREATE TRIGGER agent_runs_validate_tenant
  BEFORE INSERT OR UPDATE OF feature_id, stage_id, agent_profile_id, organization_id, swarm_id, swarm_task_id
  ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION bento_validate_run_tenant();--> statement-breakpoint

-- Every run that exists today is a pipeline stage run: ADD COLUMN ...
-- DEFAULT 'stage' NOT NULL above wrote that value onto all of them, so
-- there is no backfill left to do and no row is left without a role.
GRANT EXECUTE ON FUNCTION bento_inherit_org_any() TO bento_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  swarm_templates, swarms, swarm_tasks, swarm_task_events,
  swarm_landings, swarm_pull_requests, swarm_messages TO bento_user;
