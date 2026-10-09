-- When the agent process was started in the sandbox.
--
-- started_at is the claim, which is before the machine exists.
-- Provisioning and repository setup both happen while the run is
-- still starting. The swarm board's "working" and the long-run clock
-- mean an agent is actually running, so they read this stamp. Null
-- until the agent is exec'd, and null on runs that were already in
-- flight when the column was added: those keep the claim time.
ALTER TABLE "agent_runs" ADD COLUMN "agent_started_at" timestamp with time zone;
