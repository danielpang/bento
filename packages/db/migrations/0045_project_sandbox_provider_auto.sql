-- "auto" is a provider choice a project can hold: a Fly sprite first,
-- then a Modal sandbox when the sprite cannot be provisioned. New
-- projects start there. Existing rows keep NULL, the deployment
-- default, so nothing already running changes provider on deploy.
ALTER TABLE projects DROP CONSTRAINT projects_sandbox_provider_check;--> statement-breakpoint
ALTER TABLE projects
  ADD CONSTRAINT projects_sandbox_provider_check
  CHECK (sandbox_provider IN ('auto', 'sprite', 'modal', 'docker'));--> statement-breakpoint
ALTER TABLE projects ALTER COLUMN sandbox_provider SET DEFAULT 'auto';
