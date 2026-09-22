-- Where a swarm's agents work, written on the template instead of read
-- off the deployment.
--
-- A local install runs its swarms in worktrees of the repository it
-- already has on disk, because a container per worker is a container on
-- the machine somebody is also using; a hosted install gives each
-- worker a machine of its own. Until now that was decided by whichever
-- sandbox driver the process happened to be configured with, which
-- means the shape was a property of the environment rather than of the
-- swarm. An install that later joined a team would have had its
-- swarms change shape underneath them, and nothing would have said so.
--
-- Two values. 'worktree' is an assertion: this template's agents work
-- checkouts on the server. A deployment whose driver keeps the
-- repository inside the machine cannot keep that promise and refuses
-- the run with a sentence naming the setting, rather than silently
-- provisioning the other shape. 'sandbox' asserts nothing and lets the
-- driver decide, which is exactly what every template written before
-- this column has been doing.
--
-- So the backfill is 'sandbox', and that is not a guess dressed as a
-- fact: a row that never stated a shape is a row that makes no claim
-- about one, and 'sandbox' is the value that means no claim. Every
-- existing swarm goes on behaving precisely as it did.
--
-- The default is added for the backfill and dropped three statements
-- down, the way agent_runs.type and run_artifacts.type both are. A
-- default left standing is how a local install's next template would
-- quietly file itself as a hosted one, which is the whole failure this
-- column exists to prevent.
ALTER TABLE "swarm_templates" ADD COLUMN "worker_isolation" text DEFAULT 'sandbox' NOT NULL;--> statement-breakpoint

-- Asserted rather than assumed, the way 0025 through 0034 assert
-- theirs. The column carries no check constraint (the enum lives in
-- the drizzle schema), so a row holding a word nothing reads would sit
-- there until a query silently failed to match it.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers FROM swarm_templates
   WHERE worker_isolation IS NULL OR worker_isolation NOT IN ('sandbox', 'worktree');
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'cannot backfill swarm_templates.worker_isolation: % row(s) hold a value outside the new list', stragglers;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "swarm_templates" ALTER COLUMN "worker_isolation" DROP DEFAULT;
