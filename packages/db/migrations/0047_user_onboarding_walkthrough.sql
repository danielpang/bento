-- Whether the console opens the onboarding walkthrough for this person.
-- On for everybody, existing accounts included: skipping or finishing
-- the walkthrough turns it off, and Settings, Account turns it back on.
ALTER TABLE "identity"."user" ADD COLUMN "onboarding_walkthrough" boolean DEFAULT true NOT NULL;
