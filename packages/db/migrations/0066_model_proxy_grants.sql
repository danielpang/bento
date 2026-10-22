-- The model proxy rides the MCP gateway's run grant. In multi mode a
-- sandbox holds the grant's token in place of each provider key, and
-- the proxy swaps the organization's real key in on the way out.
-- model_credentials names the stored secrets the proxy may use for the
-- run; proxy_failed_at records that the proxy itself failed a request,
-- so a run that then fails is not billed.
ALTER TABLE "mcp_run_grants" ADD COLUMN IF NOT EXISTS "model_credentials" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "mcp_run_grants" ADD COLUMN IF NOT EXISTS "proxy_failed_at" timestamp with time zone;
