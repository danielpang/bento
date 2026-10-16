-- A usage limit pause: the reset it waits for (kept after it lifts, as
-- the line between limit failures already handled and new ones), and
-- the status it interrupted.
ALTER TABLE "swarms" ADD COLUMN IF NOT EXISTS "paused_until" timestamp with time zone;
ALTER TABLE "swarms" ADD COLUMN IF NOT EXISTS "paused_from" text;
