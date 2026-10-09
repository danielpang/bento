-- Fills agent_runs.sandbox_provider for runs from before 0053 added it.
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
-- touched, so a run since 0053 keeps what it wrote and a run still in
-- flight records its own. A run that never got a machine has no
-- sandboxes row and stays null. Running it again changes nothing.
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
  AND r."status" IN ('succeeded', 'failed', 'cancelled');
