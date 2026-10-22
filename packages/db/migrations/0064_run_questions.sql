-- Questions an agent asked a person and is blocked on: Claude Code's
-- AskUserQuestion. A tenant table, so it carries the isolation
-- machinery itself: RLS enabled and forced, the org policy, and the
-- trigger that takes organization_id from the run.
CREATE TABLE run_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 organization_id text REFERENCES identity.organization(id) ON DELETE CASCADE,
 request_id text NOT NULL,
 questions jsonb NOT NULL,
 input jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','delivered','withdrawn')),
 answers jsonb,
 answered_by text REFERENCES identity."user"(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 answered_at timestamptz,
 delivered_at timestamptz
);
CREATE UNIQUE INDEX run_questions_run_request_idx ON run_questions(run_id, request_id);
CREATE INDEX run_questions_status_idx ON run_questions(run_id, status);
ALTER TABLE run_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY run_questions_org_isolation ON run_questions
 USING (organization_id IS NOT DISTINCT FROM bento_current_org())
 WITH CHECK (organization_id IS NOT DISTINCT FROM bento_current_org());
CREATE TRIGGER run_questions_inherit_org BEFORE INSERT OR UPDATE ON run_questions
 FOR EACH ROW EXECUTE FUNCTION bento_inherit_org('agent_runs', 'run_id');
GRANT SELECT, INSERT, UPDATE, DELETE ON run_questions TO bento_user;
