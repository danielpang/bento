CREATE TABLE agent_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL REFERENCES identity."user"(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('anthropic', 'openai-codex')),
 ciphertext text NOT NULL,
 expires_at timestamptz NOT NULL,
 reconnect_required boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id, provider)
);
CREATE TABLE agent_account_logins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL REFERENCES identity."user"(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('anthropic', 'openai-codex')),
 ciphertext text NOT NULL,
 expires_at timestamptz NOT NULL,
 next_poll_at timestamptz NOT NULL,
 UNIQUE (user_id, provider)
);
-- Personal rows follow the authenticated person, never the active team.
ALTER TABLE agent_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_accounts_personal ON agent_accounts
 USING (user_id = nullif(current_setting('bento.user_id', true), ''))
 WITH CHECK (user_id = nullif(current_setting('bento.user_id', true), ''));
ALTER TABLE agent_account_logins ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_account_logins FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_account_logins_personal ON agent_account_logins
 USING (user_id = nullif(current_setting('bento.user_id', true), ''))
 WITH CHECK (user_id = nullif(current_setting('bento.user_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_accounts, agent_account_logins TO bento_user;

ALTER TABLE agent_runs ADD COLUMN personal_account_id uuid;
