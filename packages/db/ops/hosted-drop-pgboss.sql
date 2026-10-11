-- Hosted / multi databases only.
--
-- Drops the unused pgboss schema after the retention release. Local,
-- the TUI, and the Mac app still start pg-boss and must not apply this
-- file. It is not in packages/db/migrations and runMigrations will
-- never apply it.
--
-- Irreversible without restore. Do not run until:
--   1. hosted-inventory-pgboss.sql shows no created/retry rows on
--      slack.notify, linear.outbound, or linear.create-issue (import
--      leftovers first if any remain)
--   2. a hosted database backup exists
--   3. the owner has signed off that hosted rollback is restore only
--
-- Apply by hand against the hosted Neon database, development first.

DROP SCHEMA IF EXISTS pgboss CASCADE;
