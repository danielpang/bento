import { and, eq, isNull, or } from "drizzle-orm";
import type { AgentCli } from "@bento/core";
import { getAdapter } from "@bento/agents";
import { mcpServers, organizationPolicies, repositories } from "@bento/db";
import type { SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { resolveAgentEnv } from "./agent-env.js";
import { customProviderRunEnv } from "./custom-provider.js";
import { modalRunHosts } from "./modal-hosts.js";

/**
 * The network a Modal sandbox for this project must use.
 *
 * Provision and rollback both call this, so a machine booted to mount
 * a checkpoint gets the same allowlist as the one the run started in.
 * Not restricted: an empty object, and the sandbox keeps open egress.
 *
 * On top of what Bento names itself, the team's own allowlist and the
 * host of every MCP server it has enabled. The agent reaches those
 * servers through the gateway, which is already on the list, but the
 * Team settings promise that a locked team's MCP endpoints are allowed,
 * and a harness that opens one directly should find that true.
 */
export async function modalNetworkForProject(
  ctx: AppContext,
  projectId: string,
  organizationId: string | null,
  cli: AgentCli,
  model: string,
): Promise<Pick<SandboxHandle, "network" | "allowedHosts">> {
  const policy = await organizationNetworkPolicy(ctx, organizationId);
  if (!policy.restrictNetwork) return {};
  const repos = await ctx.db
    .select({ repoUrl: repositories.repoUrl })
    .from(repositories)
    .where(eq(repositories.projectId, projectId));
  const adapter = getAdapter(cli);
  const driver = ctx.drivers.get("modal") ?? ctx.drivers.default;
  const { env: resolved } = await resolveAgentEnv(ctx, organizationId, adapter, model, driver);
  const custom = await customProviderRunEnv(ctx, organizationId, cli, model);
  const env = custom ? custom.env : resolved;
  return {
    network: "restricted",
    allowedHosts: modalRunHosts({
      gatewayUrl: ctx.env.BENTO_MCP_GATEWAY_URL ?? ctx.env.BETTER_AUTH_URL,
      cloneUrls: repos.map((row) => row.repoUrl),
      env,
      ...(custom?.selection?.baseUrl ? { customBaseUrl: custom.selection.baseUrl } : {}),
      extraHosts: [...policy.allowedHosts, ...(organizationId ? await mcpServerHosts(ctx, organizationId) : [])],
    }),
  };
}

/** Whether this organization has asked for sandboxes with no egress. */
export async function organizationRestrictsNetwork(ctx: AppContext, organizationId: string | null): Promise<boolean> {
  return (await organizationNetworkPolicy(ctx, organizationId)).restrictNetwork;
}

/** The lock and the sites the team added to it. A worker path, so scoped by hand. */
async function organizationNetworkPolicy(
  ctx: AppContext,
  organizationId: string | null,
): Promise<{ restrictNetwork: boolean; allowedHosts: string[] }> {
  if (!organizationId) return { restrictNetwork: false, allowedHosts: [] };
  const [row] = await ctx.db
    .select({ restrictNetwork: organizationPolicies.restrictNetwork, allowedHosts: organizationPolicies.allowedHosts })
    .from(organizationPolicies)
    .where(eq(organizationPolicies.organizationId, organizationId))
    .limit(1);
  return { restrictNetwork: row?.restrictNetwork === true, allowedHosts: row?.allowedHosts ?? [] };
}

/**
 * Host names of the organization's enabled MCP servers, sorted and
 * without duplicates. With `userId`, only team servers and that
 * member's own, which is what Settings shows a member; without it,
 * every enabled server, which is what a run allows, since any member
 * may start the run. A URL that does not parse is left out: the
 * gateway refuses it anyway.
 */
export async function mcpServerHosts(
  ctx: AppContext,
  organizationId: string,
  userId?: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ url: mcpServers.url })
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.organizationId, organizationId),
        eq(mcpServers.enabled, true),
        ...(userId ? [or(isNull(mcpServers.userId), eq(mcpServers.userId, userId))] : []),
      ),
    );
  const hosts = new Set<string>();
  for (const row of rows) {
    try {
      const host = new URL(row.url).hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      // Not a URL, so not a host anyone could allow.
    }
  }
  return [...hosts].sort();
}
