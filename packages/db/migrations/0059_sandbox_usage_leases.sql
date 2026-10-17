CREATE TABLE sandbox_usage_leases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sandbox_id uuid NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
 organization_id text REFERENCES identity.organization(id) ON DELETE CASCADE,
 generation integer NOT NULL, purpose text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX sandbox_usage_leases_sandbox_idx ON sandbox_usage_leases(sandbox_id,expires_at);
ALTER TABLE sandbox_usage_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_usage_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY sandbox_usage_leases_org_isolation ON sandbox_usage_leases
 USING (organization_id IS NOT DISTINCT FROM bento_current_org())
 WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());
CREATE TRIGGER sandbox_usage_leases_inherit_org BEFORE INSERT OR UPDATE ON sandbox_usage_leases
 FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('sandboxes', 'sandbox_id');
GRANT SELECT, INSERT, UPDATE, DELETE ON sandbox_usage_leases TO bento_user;
