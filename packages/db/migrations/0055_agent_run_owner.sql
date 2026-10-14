-- Which server process is driving this run, and when it last said so.
--
-- owner_id is an id a process makes up when it boots, never a machine
-- id: machines are destroyed and made again, and a process that loses
-- its run must not be able to find it again by name. The heartbeat is
-- the lease. A process that holds runs stamps the column every
-- RUN_HEARTBEAT_MS; a run whose stamp is older than RUN_LEASE_MS has
-- no process behind it (dead, suspended, or cut off from the database)
-- and may be adopted by any live server, which reattaches to the agent
-- still working in the sandbox. Null on runner-executed runs, on runs
-- from before this column, and on a run its process released as it
-- shut down, all of which read as "nobody's", the way every run read
-- before this existed.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "owner_id" text;
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "owner_heartbeat_at" timestamp with time zone;
