-- Sites a team with agent network access blocked lets its agents reach,
-- on top of what Bento allows on its own (the model provider, the clone
-- remotes, the gateway). Host names or *.domain wildcards, validated by
-- parseAllowedHosts in @bento/core before they are written.
ALTER TABLE "organization_policies" ADD COLUMN "allowed_hosts" text[] DEFAULT '{}' NOT NULL;
