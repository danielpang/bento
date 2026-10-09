-- Fills agent_runs.sandbox_provider for the hosted instance's runs from
-- before 0053 added it. Nowhere else: on any other database this does
-- nothing.
--
-- It is the hosted instance's history that the rule below was checked
-- against (its runs, its rewritten rows, and the 33 of them PostHog's
-- "sandbox ready" events name, which it matched on every one), so it is
-- guarded on that instance's own organization row: organization ids
-- are random, and no other database has this one. A self-hosted
-- database, new or old, keeps every earlier run's provider null, as
-- 0053 left it. And only runs queued before 0053 shipped are read.
--
-- The sandboxes row is not enough on its own: a machine made again for
-- the same owner rewrites that row's provider (a swarm's machine went
-- sprite, Modal, sprite on one row id), so it can name a provider the
-- run never used. The run's own transcript corrects it where it can:
-- the Modal driver writes "Starting a Modal sandbox" (or "Reusing the
-- Modal sandbox ...") on every provision it makes, and no other driver
-- names a provider. So:
--
--   a Modal line in the run's transcript    -> modal
--   no Modal line, its row names a provider -> that provider
--   no Modal line, its row says modal       -> left null: the row was
--                                              rewritten after the run
--
-- Only runs that ended and never recorded a provider of their own are
-- touched, and a run that never got a machine has no sandboxes row and
-- stays null. Running it again changes nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "identity"."organization" WHERE "id" = 'LElYbC0PEXQqAvpIKqVUK89Wc6Naxivb'
  ) THEN
    RETURN;
  END IF;

  UPDATE "agent_runs" AS r
  SET "sandbox_provider" = CASE
      WHEN EXISTS (
        SELECT 1
        FROM "run_events" AS e
        WHERE e."run_id" = r."id"
          AND e."type" = 'message'
          AND e."payload" ->> 'role' = 'system'
          AND (
            e."payload" ->> 'text' = 'Starting a Modal sandbox'
            OR e."payload" ->> 'text' LIKE 'Reusing the Modal sandbox%'
          )
      ) THEN 'modal'
      WHEN s."provider" <> 'modal' THEN s."provider"
    END
  FROM "sandboxes" AS s
  WHERE s."id" = r."sandbox_id"
    AND r."sandbox_provider" IS NULL
    AND r."status" IN ('succeeded', 'failed', 'cancelled')
    AND r."queued_at" < '2026-10-09T18:32:00Z';
END
$$;
