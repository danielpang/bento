CREATE TABLE sandbox_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 organization_id text REFERENCES identity.organization(id) ON DELETE CASCADE,
 workspace_key text NOT NULL, provider text NOT NULL,
 action text NOT NULL CHECK (action IN ('provision','hibernate','wake','destroy')),
 state text NOT NULL DEFAULT 'executing' CHECK (state IN ('executing','succeeded','unknown')),
 handle jsonb, heartbeat_at timestamptz NOT NULL DEFAULT now(), error_class text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sandbox_operations_unfinished_idx ON sandbox_operations(heartbeat_at) WHERE state <> 'succeeded';
ALTER TABLE sandbox_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_operations_org_isolation ON sandbox_operations
 USING (organization_id IS NOT DISTINCT FROM bento_current_org())
 WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());
CREATE TRIGGER sandbox_operations_inherit_org BEFORE INSERT OR UPDATE ON sandbox_operations
 FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('projects', 'project_id');
GRANT SELECT, INSERT, UPDATE, DELETE ON sandbox_operations TO bento_user;
