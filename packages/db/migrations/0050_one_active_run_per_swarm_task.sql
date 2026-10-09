-- At most one agent run working a swarm task at a time.
--
-- startRunIfIdle already refuses a second run on a task under the
-- swarm row's lock. This is the backstop for a path that ever skips
-- that lock: two agents on one task are two agents committing to the
-- same branch in the same machine. Production had no task with two
-- active runs when this was added; any that appear before it runs are
-- closed first, keeping each task's newest, or the index could not be
-- built and the deploy would stop here.
UPDATE "agent_runs" AS older
   SET "status" = 'cancelled',
       "ended_at" = now(),
       "error" = 'cancelled: another run was already working this swarm task'
 WHERE older."swarm_task_id" IS NOT NULL
   AND older."status" IN ('queued', 'starting', 'running')
   AND EXISTS (
     SELECT 1 FROM "agent_runs" AS newer
      WHERE newer."swarm_task_id" = older."swarm_task_id"
        AND newer."status" IN ('queued', 'starting', 'running')
        AND (newer."queued_at", newer."id") > (older."queued_at", older."id")
   );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_one_active_per_swarm_task_idx"
  ON "agent_runs" ("swarm_task_id")
  WHERE "swarm_task_id" IS NOT NULL AND "status" IN ('queued', 'starting', 'running');
