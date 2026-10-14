-- The runs in flight, by executor. The orphan sweep, the stalled reaper
-- and boot recovery each ask for the server's active runs every few
-- minutes; without this every one of those asks was a scan of the whole
-- table, which grows with every run ever made. Partial, because the rows
-- in flight are a handful at any moment and the finished ones are never
-- asked for this way.
CREATE INDEX IF NOT EXISTS "agent_runs_active_idx" ON "agent_runs" ("executor", "status")
  WHERE "status" IN ('queued', 'starting', 'running');
