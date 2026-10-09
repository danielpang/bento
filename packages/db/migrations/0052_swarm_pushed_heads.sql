-- The commit Bento last pushed to a swarm's branch on GitHub, per
-- repository url. The branch is pushed after every landing so a lost
-- machine loses nothing, and this is the lease each later push holds.
ALTER TABLE "swarms" ADD COLUMN IF NOT EXISTS "pushed_heads" jsonb DEFAULT '{}'::jsonb NOT NULL;
