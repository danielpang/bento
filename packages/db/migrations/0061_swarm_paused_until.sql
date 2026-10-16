-- When a swarm paused on its agents' usage limit starts again, read
-- from the reset the agent CLI printed. Also the line between limit
-- failures already acted on and new ones, so it stays set once the
-- pause lifts.
ALTER TABLE "swarms" ADD COLUMN IF NOT EXISTS "paused_until" timestamp with time zone;
