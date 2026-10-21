-- Whether a run's agent was started as a live stdin session. A server
-- reattaching after a restart reads it, so a beta flag that changed in
-- between cannot change how a running process is spoken to. Null on
-- older runs, which decide as they always did.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "live_session" boolean;
