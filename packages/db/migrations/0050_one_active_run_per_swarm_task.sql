-- At most one agent run working a swarm task at a time.
--
-- startRunIfIdle already refuses a second run on a task under the
-- swarm row's lock. This is the backstop for a path that ever skips
-- that lock: two agents on one task are two agents committing to the
-- same branch in the same machine. Production had no task with two
-- active runs when this was added.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_one_active_per_swarm_task_idx"
  ON "agent_runs" ("swarm_task_id")
  WHERE "swarm_task_id" IS NOT NULL AND "status" IN ('queued', 'starting', 'running');
