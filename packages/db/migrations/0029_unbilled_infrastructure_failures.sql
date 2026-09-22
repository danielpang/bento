-- A run that failed because Bento or Fly could not start or keep the
-- sprite is not agent hours. Clearing started_at is the signal every
-- hours sum already honors: a run with no start counts as zero. The
-- failure text stays, so the card still says why it went red.
--
-- Kept in step with isInfrastructureFailure. Caller configuration
-- (two repositories on one checkout, a lockdown this deployment
-- cannot honor) is left alone. So is an agent that ran and failed,
-- a timeout, and a restart.
UPDATE agent_runs
SET started_at = NULL
WHERE status = 'failed'
  AND started_at IS NOT NULL
  AND (
    (
      error LIKE 'sandbox provisioning failed:%'
      AND error NOT LIKE 'sandbox provisioning failed: Repositories % use the same checkout%'
      AND error NOT LIKE 'sandbox provisioning failed: This organization requires agents to run without network access%'
    )
    OR error LIKE 'exec failed:%'
    OR error LIKE '%is not installed in this sandbox, so the agent never started%'
  );
