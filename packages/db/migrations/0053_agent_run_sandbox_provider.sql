-- The sandbox provider that ran this run: the driver that made or
-- reopened its machine, after any "auto" fallback. The sandboxes row
-- names a provider too, but a machine made again for the same owner
-- rewrites that row, so it cannot say which provider an earlier run
-- used. Null until the run provisions, on a run whose provisioning
-- failed, and on every run from before this column. Those are not
-- backfilled from sandboxes, for the same reason.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "sandbox_provider" text;
