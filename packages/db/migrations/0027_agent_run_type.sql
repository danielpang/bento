-- Which board a run belongs to, said outright.
--
-- 0023 tied feature_id and swarm_id to each other, which is a weaker
-- statement than it looks: it says a run has exactly one owner, not
-- which kind of run it is, and it cannot say that a judge run is a
-- card's judge rather than a swarm's. A judge exists on both boards,
-- so `role` cannot answer that either. The two are separate axes.
--
-- Added with a default so the backfill is metadata only on a table
-- that is hot on every board, then the default is dropped in the same
-- migration: every insert from here on states its board, because a
-- default is how a swarm run would quietly file itself as a card's.
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_feature_or_swarm";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "type" text DEFAULT 'pipeline' NOT NULL;--> statement-breakpoint

-- Every run that exists is a card's: swarm runs have no door to come
-- in through yet. Asserted rather than assumed, because a row that is
-- not a card's would fail the shape constraint below with a message
-- about a constraint rather than about the backfill that was wrong.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers FROM agent_runs WHERE feature_id IS NULL OR stage_id IS NULL;
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'cannot backfill agent_runs.type: % run(s) name no card', stragglers;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "agent_runs" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_pipeline_shape" CHECK ("agent_runs"."type" <> 'pipeline' or ("agent_runs"."feature_id" is not null and "agent_runs"."stage_id" is not null
        and "agent_runs"."swarm_id" is null and "agent_runs"."swarm_task_id" is null));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_swarm_shape" CHECK ("agent_runs"."type" <> 'swarm' or ("agent_runs"."swarm_id" is not null and "agent_runs"."feature_id" is null and "agent_runs"."stage_id" is null));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_role_for_type" CHECK (("agent_runs"."type" = 'pipeline' and "agent_runs"."role" in ('stage', 'judge', 'rebase'))
        or ("agent_runs"."type" = 'swarm' and "agent_runs"."role" in ('planner', 'subplanner', 'worker', 'resolver', 'judge')));--> statement-breakpoint

-- The tenant check, said in terms of the discriminator.
--
-- It used to branch on whether swarm_id happened to be set, which is
-- the same question asked of the data instead of the row's own
-- statement about itself. The shape constraints now make the two agree,
-- so branching on the type is both clearer and stricter: a row whose
-- discriminator disagrees with its columns cannot reach here at all.
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

  IF NEW.type = 'swarm' THEN
    -- Presence before tenancy, for the same reason as the card branch
    -- below: a null swarm reads as an organization of null, which in
    -- multi mode surfaces as a boundary error about a swarm that was
    -- never named. The shape constraint says this too, and gets there
    -- second because a BEFORE trigger runs first.
    IF NEW.swarm_id IS NULL THEN
      RAISE EXCEPTION 'a swarm agent run must name its swarm';
    END IF;
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

  -- A card run. The shape constraint says the same thing, and gets
  -- there second: a BEFORE trigger runs first, and without this the
  -- missing stage would surface as a tenant boundary error in multi
  -- mode (a null stage has a null organization) and as the constraint
  -- in local mode. One message, both modes.
  IF NEW.feature_id IS NULL OR NEW.stage_id IS NULL THEN
    RAISE EXCEPTION 'a pipeline agent run must name its card and its stage';
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

-- The discriminator joins the update list: repointing a run at the
-- other board has to be re-validated like any other reference change.
DROP TRIGGER agent_runs_validate_tenant ON agent_runs;--> statement-breakpoint
CREATE TRIGGER agent_runs_validate_tenant
  BEFORE INSERT OR UPDATE OF feature_id, stage_id, agent_profile_id, organization_id, swarm_id, swarm_task_id, type
  ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION bento_validate_run_tenant();
