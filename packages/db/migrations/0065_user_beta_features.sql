-- Beta features on a hosted server: a team's owner or admin allows
-- them, and each member then turns them on for themselves. Off for
-- every team and every person until they do. Local Bento ignores both
-- and reads its own startup flag (BENTO_BETA_FEATURES).
ALTER TABLE "identity"."user" ADD COLUMN "beta_features" boolean DEFAULT false NOT NULL;
ALTER TABLE "identity"."organization" ADD COLUMN "beta_features_allowed" boolean DEFAULT false NOT NULL;
