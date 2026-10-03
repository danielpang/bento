ALTER TABLE projects
  ADD COLUMN sandbox_provider text
  CONSTRAINT projects_sandbox_provider_check
  CHECK (sandbox_provider IN ('sprite', 'modal', 'docker'));
