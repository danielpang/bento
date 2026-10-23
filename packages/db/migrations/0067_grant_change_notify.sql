-- The model proxy caches a resolved grant and its decrypted keys for a
-- few minutes per server process, so it must hear when a grant stops
-- being good. Many paths end a run with a bare UPDATE of its status
-- and never revoke its grant, and more will be written, so the
-- database announces it rather than each path: when a run leaves the
-- queued, starting and running statuses, and when a grant row changes
-- in a way its holders depend on (revoked, re-minted, its failure
-- stamp set or cleared, extended, its keys or tenant changed) or is
-- deleted, which a deleted run's cascade does too.
--
-- The notification goes onto bento_bus, the channel every server
-- process LISTENs on (apps/server/src/pg-bus.ts), as a grant_changed
-- event from origin "database", so the writer's own process hears it
-- like every other. It is sent on commit only, and carries the run id,
-- never a token or a key.
CREATE FUNCTION bento_notify_grant_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed_run uuid;
BEGIN
  IF TG_TABLE_NAME = 'agent_runs' THEN
    changed_run := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    changed_run := OLD.run_id;
  ELSE
    changed_run := NEW.run_id;
  END IF;
  PERFORM pg_notify(
    'bento_bus',
    json_build_object('origin', 'database', 'kind', 'grant_changed', 'runId', changed_run)::text
  );
  RETURN NULL;
END $$;
CREATE TRIGGER agent_runs_grant_changed AFTER UPDATE OF status ON agent_runs
 FOR EACH ROW
 WHEN (OLD.status IN ('queued', 'starting', 'running') AND NEW.status NOT IN ('queued', 'starting', 'running'))
 EXECUTE FUNCTION bento_notify_grant_changed();
CREATE TRIGGER mcp_run_grants_changed AFTER UPDATE ON mcp_run_grants
 FOR EACH ROW
 WHEN (
   OLD.token_hash IS DISTINCT FROM NEW.token_hash
   OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
   OR OLD.proxy_failed_at IS DISTINCT FROM NEW.proxy_failed_at
   OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
   OR OLD.model_credentials IS DISTINCT FROM NEW.model_credentials
   OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
 )
 EXECUTE FUNCTION bento_notify_grant_changed();
CREATE TRIGGER mcp_run_grants_deleted AFTER DELETE ON mcp_run_grants
 FOR EACH ROW EXECUTE FUNCTION bento_notify_grant_changed();
