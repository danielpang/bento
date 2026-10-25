-- A swarm task's runs, newest first: the planner's get_tree and
-- read_task_runs read them for every leaf.
CREATE INDEX IF NOT EXISTS agent_runs_swarm_task_queued_idx ON agent_runs(swarm_task_id, queued_at);
