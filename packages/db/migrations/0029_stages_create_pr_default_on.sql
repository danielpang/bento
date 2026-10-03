-- A stage publishes unless somebody turns it off. The flag shipped off
-- by default, and the first thing a new project did was run a card to
-- completion and then wonder where the pull request was. Only the
-- default changes: a stage that already exists keeps the choice its
-- owner made.
ALTER TABLE "stages" ALTER COLUMN "create_pr" SET DEFAULT true;
