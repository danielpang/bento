-- Whether a run counts toward the agent-hours limit. True by default,
-- including runs already in the table. A run that failed because Fly
-- or the sprite driver could not create the machine is marked false.
-- started_at stays: it is when the run was claimed, and the hours sum
-- reads this column.
--
-- Only the first line is the reason. The same three shapes as
-- UNBILLED_REASONS: a driver error class (APIError and the like), a
-- sprite that was never acquired, and an exec handshake that died
-- before the command started. A git failure, a missing CLI after the
-- agent was running, an exec throw, a timeout, and a restart stay
-- billable. A reason added later sets the flag when that run finishes.
-- It does not change rows that already closed.
ALTER TABLE agent_runs
  ADD COLUMN billable boolean DEFAULT true NOT NULL;

UPDATE agent_runs
SET billable = false
WHERE status = 'failed'
  AND (
    split_part(error, E'\n', 1) ~ '^sandbox provisioning failed: [A-Za-z][A-Za-z0-9]*Error([^A-Za-z0-9_]|$)'
    OR split_part(error, E'\n', 1) ~ '^sandbox provisioning failed: could not acquire sprite [^[:space:]]+([^A-Za-z0-9_]|$)'
    OR split_part(error, E'\n', 1) ~ '^sandbox provisioning failed: sprite [^[:space:]]+ was not created([^A-Za-z0-9_]|$)'
    OR split_part(error, E'\n', 1) LIKE 'sandbox provisioning failed: the sandbox exec connection failed before the command started%'
  );
