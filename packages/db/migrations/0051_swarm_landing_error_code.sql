-- Why a merge queue landing failed, as a stable code the console and
-- analytics read, beside the sentence in "error" that is for people.
ALTER TABLE "swarm_landings" ADD COLUMN IF NOT EXISTS "error_code" text;--> statement-breakpoint
-- A landing sent back to the queue after a sandbox could not be
-- reached waits until this before it is promoted again.
ALTER TABLE "swarm_landings" ADD COLUMN IF NOT EXISTS "not_before" timestamp with time zone;
