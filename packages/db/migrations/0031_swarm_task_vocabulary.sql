-- The plan's vocabulary, said the way the product says it.
--
-- 0023 shipped swarm_tasks with kind group|task and a status list of
-- its own (pending, planning, ready, running, landing, ...). The
-- approved spec, and the console built against it, say plan|leaf and
-- open, assigned, working, landed, done, blocked, failed, cancelled.
-- Two vocabularies for one table means a translation table in the
-- route layer, and a translation table is how both survive forever.
-- The database moves, because it is the one nobody outside this
-- repository has read yet.
--
-- attention keeps both sets rather than choosing. The spec's
-- long_running and escalated are severity, set by the clock, and the
-- schema's question, blocked, failed, conflict and budget are reasons,
-- set by an event. They answer the same question a board asks, which
-- is which node a person should look at, so they share one nullable
-- column, and null still means no attention. Neither is derivable from
-- the other, and dropping either would leave a later phase (the long
-- running worker watchdog, or a planner's question) with nowhere to
-- write.
--
-- These columns are plain text with no check constraint, so the enum
-- lives in the drizzle schema and this migration is the defaults plus
-- the rows. Both are stated: a default left at 'task' would file every
-- future node under a kind nothing reads.
ALTER TABLE "swarm_tasks" ALTER COLUMN "kind" SET DEFAULT 'leaf';--> statement-breakpoint
ALTER TABLE "swarm_tasks" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint

-- The rows, if a database somewhere has any. Nothing has ever created
-- one (no route reached this table before this change), so these are
-- expected to touch nothing, and the assertion below is what turns
-- "expected" into "checked".
UPDATE "swarm_tasks" SET "kind" = 'plan' WHERE "kind" = 'group';--> statement-breakpoint
UPDATE "swarm_tasks" SET "kind" = 'leaf' WHERE "kind" = 'task';--> statement-breakpoint
UPDATE "swarm_tasks" SET "status" = 'open' WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "swarm_tasks" SET "status" = 'assigned' WHERE "status" = 'ready';--> statement-breakpoint
-- A plan node being decomposed by a sub planner is a node an agent is
-- working, which is what the new list calls it.
UPDATE "swarm_tasks" SET "status" = 'working' WHERE "status" IN ('running', 'planning');--> statement-breakpoint
-- A landing in flight has not landed. It goes back to working, which
-- is where the merge queue picks it up again.
UPDATE "swarm_tasks" SET "status" = 'working' WHERE "status" = 'landing';--> statement-breakpoint

-- Asserted rather than assumed, the way 0024 asserts its backfill: a
-- row left holding a word nothing reads would be invisible until some
-- query silently failed to match it.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers FROM swarm_tasks
   WHERE kind NOT IN ('plan', 'leaf')
      OR status NOT IN ('open', 'assigned', 'working', 'landed', 'done', 'blocked', 'failed', 'cancelled')
      OR (attention IS NOT NULL AND attention NOT IN
          ('long_running', 'escalated', 'question', 'blocked', 'failed', 'conflict', 'budget'));
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'cannot migrate swarm_tasks: % row(s) still hold a value outside the new lists', stragglers;
  END IF;
END
$$;
