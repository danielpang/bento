-- One word, one question. Two of them.
--
-- Both halves take a column that answers a question by implication and
-- make it answer outright, so they travel together.
--
-- swarm_tasks.attention loses 'blocked'. 0025 merged two value sets
-- into one union and kept everything either of them had, so the same
-- word ended up in status and in attention: in one it says the node is
-- stuck, in the other that a person is wanted. A reader had to know
-- which column they were looking at before they knew what the word
-- meant, and status already carries the fact. What is left in attention
-- is what status cannot say: long_running and escalated, which the
-- clock sets, and question, failed, conflict and budget, which an event
-- does.
--
-- run_artifacts gains a type. It had the shape agent_runs left behind
-- in 0024: feature_id and swarm_id both nullable under an exactly-one
-- constraint, so which board a row belongs to was a fact about which
-- column happened to be filled in rather than the row's own statement
-- about itself. Same treatment, same reasons, and the same two shape
-- checks so a row whose columns disagree with its type cannot exist.

-- A blocked node is a blocked node, which its status says. Nulled
-- rather than translated: attention is "does a person need to come",
-- and being stuck is not on its own an answer to that.
UPDATE "swarm_tasks" SET "attention" = NULL WHERE "attention" = 'blocked';--> statement-breakpoint

-- Asserted the way 0025, 0026 and 0027 assert theirs. These columns
-- carry no check constraint (the enum lives in the drizzle schema), so
-- a row left holding a word nothing reads would sit there unnoticed
-- until a query silently failed to match it.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers FROM swarm_tasks
   WHERE attention IS NOT NULL
     AND attention NOT IN ('long_running', 'escalated', 'question', 'failed', 'conflict', 'budget');
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'cannot migrate swarm_tasks.attention: % row(s) still hold a value outside the new list', stragglers;
  END IF;
END
$$;--> statement-breakpoint

-- The discriminator, added with a default so the backfill is metadata
-- only, and the default dropped in the same migration a few statements
-- down: a default is how a swarm's artifact would quietly file itself
-- as a card's, and every insert from here on states its board.
--
-- The exactly-one constraint goes first, because the shape checks below
-- say everything it said and say which board as well.
ALTER TABLE "run_artifacts" DROP CONSTRAINT "run_artifacts_feature_or_swarm";--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD COLUMN "type" text DEFAULT 'pipeline' NOT NULL;--> statement-breakpoint

-- A real backfill rather than a formality. Almost every artifact that
-- exists is a card's, which is what the default writes, but the swarm
-- capture path is in this branch and a database somebody has been
-- running it against holds rows the default would misfile.
UPDATE "run_artifacts" SET "type" = 'swarm' WHERE "swarm_id" IS NOT NULL;--> statement-breakpoint

-- Checked before the constraints go on, so a row that disagrees is
-- reported as the backfill it came from rather than as a constraint
-- violation on a table nobody was looking at.
DO $$
DECLARE
  stragglers bigint;
BEGIN
  SELECT count(*) INTO stragglers FROM run_artifacts
   WHERE "type" NOT IN ('pipeline', 'swarm')
      OR ("type" = 'pipeline' AND (feature_id IS NULL OR swarm_id IS NOT NULL OR swarm_task_id IS NOT NULL))
      OR ("type" = 'swarm' AND (swarm_id IS NULL OR feature_id IS NOT NULL));
  IF stragglers > 0 THEN
    RAISE EXCEPTION 'cannot backfill run_artifacts.type: % row(s) name a board their columns disagree with', stragglers;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "run_artifacts" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_pipeline_shape" CHECK ("run_artifacts"."type" <> 'pipeline' or ("run_artifacts"."feature_id" is not null and "run_artifacts"."swarm_id" is null and "run_artifacts"."swarm_task_id" is null));--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_swarm_shape" CHECK ("run_artifacts"."type" <> 'swarm' or ("run_artifacts"."swarm_id" is not null and "run_artifacts"."feature_id" is null));
