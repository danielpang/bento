-- Infrastructure that fails before an agent starts must not consume
-- either agent-hour quota or a swarm's assumed dollar budget. True is
-- the safe default for every new run: finishRun changes it to false
-- only for a small, reviewed list of provider failures.
ALTER TABLE "agent_runs" ADD COLUMN "billable" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- Apply the same classification to failures already recorded. Match
-- only the opening line. Later lines are command output and cannot
-- decide whether a run counts.
UPDATE "agent_runs"
SET "billable" = false,
    "cost_usd" = NULL,
    "cost_tier" = NULL,
    "input_tokens" = NULL,
    "output_tokens" = NULL,
    "price_per_mtok" = NULL
WHERE "status" = 'failed'
  AND split_part(coalesce("error", ''), E'\n', 1) ~ (
    '^sandbox provisioning failed: [A-Za-z][A-Za-z0-9]*Error(?:[^A-Za-z0-9_]|$)'
    || '|^sandbox provisioning failed: (?:could not acquire sprite [^[:space:]]+|sprite [^[:space:]]+ was not created)(?:[^A-Za-z0-9_]|$)'
    || '|^sandbox provisioning failed: the sandbox exec connection failed before the command started'
  );--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_runs'
      AND column_name = 'billable'
      AND is_nullable = 'NO'
      AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION '0037_unbilled_runs did not install agent_runs.billable correctly';
  END IF;
END $$;
