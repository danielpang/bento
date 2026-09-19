-- One column for what a run is, not two.
--
-- agent_runs carried both `kind` (task, judge, rebase) and `role`
-- (stage, judge, rebase, and the swarm's). On the pipeline they said
-- the same thing in different words, and every insert had to set both
-- and keep them in step by hand. `role` is the one that survives: it
-- answers the question for both boards, and `kind` could never say
-- anything about a swarm.
--
-- The backfill is a real one rather than a formality. `role` arrived in
-- 0023 with DEFAULT 'stage' NOT NULL, which wrote 'stage' onto every
-- existing row including the judges and the rebases, and every insert
-- since has set `kind` and left `role` to that default. So the truth
-- about which runs are judges lives in `kind` alone, and dropping the
-- column without moving it would silently reclassify every judge run in
-- the table as ordinary work: the spend page counts what is not a
-- judge, and the gate looks for one.
UPDATE "agent_runs" SET "role" = 'judge' WHERE "kind" = 'judge' AND "role" <> 'judge';--> statement-breakpoint
UPDATE "agent_runs" SET "role" = 'rebase' WHERE "kind" = 'rebase' AND "role" <> 'rebase';--> statement-breakpoint
UPDATE "agent_runs" SET "role" = 'stage' WHERE "kind" = 'task' AND "type" = 'pipeline' AND "role" <> 'stage';--> statement-breakpoint

-- Asserted before the column goes, the way 0024 asserts its backfill:
-- once it is dropped there is nothing left to compare against, and a
-- row that disagreed would be a judge counted as work forever.
DO $$
DECLARE
  disagreeing bigint;
BEGIN
  SELECT count(*) INTO disagreeing FROM agent_runs
   WHERE ("kind" = 'judge' AND "role" <> 'judge')
      OR ("kind" = 'rebase' AND "role" <> 'rebase')
      OR ("kind" = 'task' AND "type" = 'pipeline' AND "role" <> 'stage');
  IF disagreeing > 0 THEN
    RAISE EXCEPTION 'cannot drop agent_runs.kind: % run(s) still disagree with role', disagreeing;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "agent_runs" DROP COLUMN "kind";
