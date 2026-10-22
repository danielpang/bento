-- Whether this person chose to try beta features. Null until they
-- choose. True turns beta on whatever the PostHog flag says; false
-- turns it off in local mode, where beta is otherwise on, and in multi
-- mode leaves the PostHog flag to decide.
ALTER TABLE "identity"."user" ADD COLUMN "beta_features" boolean;
