-- A run that failed because Fly or the sprite driver could not create
-- the machine is not agent hours. Clearing started_at is the signal
-- every hours sum already honors: a run with no start counts as zero.
-- The failure text stays, so the card still says why it went red.
--
-- Only the first line is the reason. The same three shapes as
-- UNBILLED_REASONS: a driver error class (APIError and the like), a
-- sprite that was never acquired, and an exec handshake that died
-- before the command started. A git failure, a missing CLI after the
-- agent was running, an exec throw, a timeout, and a restart keep
-- their start. Adding a reason later is a row in that list, not
-- another migration.
UPDATE agent_runs
SET started_at = NULL
WHERE status = 'failed'
  AND started_at IS NOT NULL
  AND (
    split_part(error, E'\n', 1) ~ '^sandbox provisioning failed: [A-Za-z][A-Za-z0-9]*Error([^A-Za-z0-9_]|$)'
    OR split_part(error, E'\n', 1) ~ '^sandbox provisioning failed: could not acquire sprite [^[:space:]]+([^A-Za-z0-9_]|$)'
    OR split_part(error, E'\n', 1) ~ '^sandbox provisioning failed: sprite [^[:space:]]+ was not created([^A-Za-z0-9_]|$)'
    OR split_part(error, E'\n', 1) LIKE 'sandbox provisioning failed: the sandbox exec connection failed before the command started%'
  );
