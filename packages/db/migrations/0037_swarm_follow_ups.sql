-- What a swarm produces, where it starts from, and how it is taken up
-- again after it has finished.
--
-- Phase four adds four things a swarm row could not say. Every one of
-- them is a column on a table swarms already have; no new table, so no
-- new isolation machinery is owed here.

-- Whether this template's swarms produce code or a document.
--
-- A document swarm is the same tree of leaves worked by the same
-- agents, and it differs in three places: a leaf writes a section
-- rather than a change, the planner assembles the sections into one
-- file at the end, and a repository's setup and test commands are not
-- run, because there is nothing to build and nothing to test.
--
-- A default that stays, unlike worker_isolation's. That column is an
-- assertion about the deployment, and a template that never made one
-- had to go on making none. This is a description of the work, 'code'
-- is what every swarm written so far actually produced, and a template
-- that says nothing about it is a template producing code.
ALTER TABLE "swarm_templates" ADD COLUMN "deliverable" text DEFAULT 'code' NOT NULL;--> statement-breakpoint

-- Where a document swarm's assembled file is written, relative to the
-- first repository's root. Null means "work it out from the swarm's
-- slug", which is docs/<slug>.md.
ALTER TABLE "swarm_templates" ADD COLUMN "document_path" text;--> statement-breakpoint

-- The agent that reads a finished swarm before it is called done, and
-- the command that has to pass first.
--
-- Both optional, and both gate the same moment: the root rolling up to
-- done. A template that names neither behaves exactly as it does now,
-- which is why neither is backfilled with anything. Set null on
-- delete, like every other link from a row to an agent: removing an
-- agent must not take the template with it.
ALTER TABLE "swarm_templates" ADD COLUMN "judge_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD COLUMN "completion_command" text;--> statement-breakpoint
ALTER TABLE "swarm_templates"
  ADD CONSTRAINT "swarm_templates_judge_profile_id_agent_profiles_id_fk"
  FOREIGN KEY ("judge_profile_id") REFERENCES "public"."agent_profiles"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- How deep a plan may be decomposed by an agent rather than by the one
-- planner.
--
-- One means what happens today: the planner writes the whole tree
-- itself. Two lets a plan node be handed to a sub planner of its own,
-- which is given that node's subtree and nothing else. It is a ceiling
-- rather than a switch, because the cost of getting it wrong is a
-- planner that plans planners.
ALTER TABLE "swarm_templates" ADD COLUMN "max_plan_depth" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- The same deliverable, copied onto the swarm at the moment it starts.
--
-- Copied rather than read back through the template for the reason the
-- ceilings are copied: a template edited in March must not change what
-- a swarm that ran in February was producing.
ALTER TABLE "swarms" ADD COLUMN "deliverable" text DEFAULT 'code' NOT NULL;--> statement-breakpoint

-- The branch this swarm started from, when it started from one.
--
-- Null is the ordinary case: the swarm's branch is cut from each
-- repository's default branch. A name here is a person saying the work
-- continues on a branch that already exists, so the swarm's branch is
-- cut from that instead and the planner is told what is on it.
ALTER TABLE "swarms" ADD COLUMN "start_branch" text;--> statement-breakpoint

-- How many times this swarm has been reopened with a follow up.
--
-- Counted rather than inferred from the tree, because it is what names
-- the follow up nodes ("Follow up 2") and what a person reads on the
-- header to know that what they are looking at is not the first pass.
ALTER TABLE "swarms" ADD COLUMN "reopen_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- What a reopened swarm was asked to do, written on the node that holds
-- the work it asked for.
--
-- On the node rather than on the swarm, because a swarm can be
-- reopened more than once and each follow up is its own subtree. Null
-- on every node the first pass created, which is how both views know
-- which subtree to label.
ALTER TABLE "swarm_tasks" ADD COLUMN "follow_up_instruction" text;--> statement-breakpoint

-- The snapshot a machine was put away at, when its driver can take
-- one.
--
-- A paused swarm is one nobody is working in and everybody is still
-- paying for, and the point of a checkpoint is that resuming it starts
-- from where it stopped rather than from a fresh clone: a sandbox that
-- spent ten minutes installing a toolchain should not spend them
-- again. On the sandbox rather than on a run, because there is no run
-- at the moment a person pauses; agent_runs.checkpoint_id is a
-- different fact (what one run may be rolled back to).
--
-- Null on every driver that cannot snapshot, which is every local one,
-- and null is not a failure there: their containers hold nothing worth
-- keeping that the repository on the host does not already have.
ALTER TABLE "sandboxes" ADD COLUMN "checkpoint_id" text;
