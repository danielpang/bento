-- A card's pull requests are keyed by the branch they were opened
-- from, so a card that merges one branch and starts another keeps both.
--
-- Added nullable and backfilled rather than NOT NULL outright: the
-- column has no default that would be true of an existing row, and
-- every existing row belongs to the branch its card is on, because
-- until now there could only be one row per repository.
--
-- FORCE ROW LEVEL SECURITY applies to the table's owner too, so a
-- migration role that is not a superuser would quietly backfill only
-- the rows of whatever organization the session claims, which is none.
-- Lifted for the backfill and put straight back; bento_user is not the
-- owner, so its isolation is untouched throughout.
--
-- Both tables, not just the one being written. The backfill reads the
-- branch out of "features", which carries the same policy, and a join
-- that matched no card would have left every existing row with an
-- empty branch: divorced from its card, invisible to the merge and
-- check reads, and duplicated by the next publish. Lifting one of the
-- two is worse than lifting neither.
ALTER TABLE "feature_pull_requests" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "feature_pull_requests" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "features" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

UPDATE "feature_pull_requests" pr
   SET "branch" = coalesce(f."branch_name", '')
  FROM "features" f
 WHERE f."id" = pr."feature_id";--> statement-breakpoint

-- A row whose card has no branch name: a card can publish before
-- anything names its branch, under the feature/<id8> the run derives,
-- so the same derivation is what its rows get here. Empty only for a
-- row whose card is gone, which the foreign key does not allow.
UPDATE "feature_pull_requests" pr
   SET "branch" = 'feature/' || left(f."id"::text, 8)
  FROM "features" f
 WHERE f."id" = pr."feature_id" AND pr."branch" = '';--> statement-breakpoint
UPDATE "feature_pull_requests" SET "branch" = '' WHERE "branch" IS NULL;--> statement-breakpoint

ALTER TABLE "features" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_pull_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_pull_requests" ALTER COLUMN "branch" SET NOT NULL;--> statement-breakpoint

DROP INDEX "feature_pull_requests_feature_repo_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "feature_pull_requests_feature_repo_branch_idx" ON "feature_pull_requests" USING btree ("feature_id","repo_url","branch");
