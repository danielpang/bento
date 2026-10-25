CREATE TABLE user_secrets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL REFERENCES identity."user"(id) ON DELETE CASCADE,
 name text NOT NULL,
 ciphertext text NOT NULL,
 hint text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id, name)
);
ALTER TABLE user_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY user_secrets_personal ON user_secrets
 USING (user_id = nullif(current_setting('bento.user_id', true), ''))
 WITH CHECK (user_id = nullif(current_setting('bento.user_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON user_secrets TO bento_user;
ALTER TABLE agent_runs ADD COLUMN personal_credential_ids jsonb NOT NULL DEFAULT '{}'::jsonb;
