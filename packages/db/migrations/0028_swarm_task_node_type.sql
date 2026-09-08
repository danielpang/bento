-- What a swarm node is, said in the column's own name.
--
-- swarm_tasks.kind holds plan or leaf, which answers the one structural
-- question the tree asks of a node: does it decompose into children, or
-- is it work handed to an agent. "kind" says none of that, and this
-- repository already spends the word on feature_events, run_artifacts,
-- the board and bus payload discriminators and the artifact classifier,
-- so a reader meeting swarm_tasks.kind has to go and find out which of
-- those it resembles. node_type answers at the call site.
--
-- A rename, not a new column beside the old one: the values are
-- unchanged, so unlike 0025 and 0026 there is nothing to backfill and
-- no two sources of truth to reconcile. NOT NULL and DEFAULT 'leaf'
-- travel with the column rather than being restated here, which is why
-- the assertion below checks that they arrived.
ALTER TABLE "swarm_tasks" RENAME COLUMN "kind" TO "node_type";--> statement-breakpoint

-- Confirmed rather than assumed, the way 0025 and 0026 confirm their
-- own work. A rename that did not land leaves every swarm query reading
-- a column that is not there, and the place to find that out is here
-- rather than at the first read of a board.
DO $$
DECLARE
  renamed bigint;
  leftover bigint;
BEGIN
  SELECT count(*) INTO renamed FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'swarm_tasks'
     AND column_name = 'node_type'
     AND is_nullable = 'NO'
     AND column_default = '''leaf''::text';
  IF renamed <> 1 THEN
    RAISE EXCEPTION 'swarm_tasks.node_type is missing, or lost NOT NULL DEFAULT ''leaf'' in the rename';
  END IF;

  SELECT count(*) INTO leftover FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'swarm_tasks' AND column_name = 'kind';
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'swarm_tasks still carries a kind column after the rename';
  END IF;

  SELECT count(*) INTO leftover FROM swarm_tasks WHERE node_type NOT IN ('plan', 'leaf');
  IF leftover > 0 THEN
    RAISE EXCEPTION 'swarm_tasks: % row(s) hold a node_type outside plan and leaf', leftover;
  END IF;
END
$$;
