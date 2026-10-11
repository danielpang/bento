-- Hosted / multi databases only. Read-only.
--
-- Inventory leftover pg-boss rows after one full BullMQ release.
-- Local, the TUI, and the Mac app keep pg-boss; do not run this as a
-- reason to change those databases.
--
-- Payload-only queues (must be empty, or imported, before the drop):
--   slack.notify, linear.outbound, linear.create-issue
-- Every other named queue is rebuilt from rows, re-scheduled in Redis,
-- or is a stale webhook/request from before the cutover.

SELECT EXISTS(
  SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'
) AS pgboss_present;

-- Outstanding work by queue and state. Empty (or schema already gone)
-- is what the drop expects for payload-only created/retry rows.
SELECT name, state::text AS state, count(*)::bigint AS n
FROM pgboss.job
WHERE state::text IN ('created', 'retry', 'active')
GROUP BY 1, 2
ORDER BY 1, 2;

-- Export of payload-only leftovers. Save this result. Those three
-- queues carry information no domain row holds.
SELECT id, name, data, state::text AS state, start_after, created_on
FROM pgboss.job
WHERE name IN ('slack.notify', 'linear.outbound', 'linear.create-issue')
  AND state::text IN ('created', 'retry')
ORDER BY created_on ASC;
