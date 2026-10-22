-- Whether this person turned beta features on. Off for everyone until
-- they do, from Settings, Account or the desktop app's launcher;
-- nothing else turns beta on.
ALTER TABLE "identity"."user" ADD COLUMN "beta_features" boolean DEFAULT false NOT NULL;
