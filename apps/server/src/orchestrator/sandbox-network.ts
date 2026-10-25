import { and, eq, isNull } from "drizzle-orm";
import { MAX_ALLOWED_HOSTS, parseAllowedHost, type AgentCli } from "@bento/core";
import { getAdapter } from "@bento/agents";
import { mcpServers, organizationPolicies, repositories, type Db } from "@bento/db";
import type { SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import type { PersonalCredentialIds } from "../agent-accounts/credentials.js";
import { resolveAgentEnv } from "./agent-env.js";
import { customProviderRunEnv } from "./custom-provider.js";
import { modalRunHosts } from "./modal-hosts.js";
import { planModelProxy } from "./model-proxy-env.js";

/**
 * The network a Modal sandbox for this project must use.
 *
 * Provision and rollback both call this, so a machine booted to mount
 * a checkpoint gets the same allowlist as the one the run started in.
 * Not restricted: an empty object, and the sandbox keeps open egress.
 *
 * On top of what Bento names itself, the sites the team allowed, which
 * is the stored list and nothing else: a team MCP server's endpoint is
 * put there when it is enabled (`allowMcpHosts`), so a person who
 * removes it from the list has removed it from every run.
 */
export async function modalNetworkForProject(
  ctx: AppContext,
  projectId: string,
  organizationId: string | null,
  cli: AgentCli,
  model: string,
  actingUserId: string | null = null,
  personalCredentialIds: PersonalCredentialIds = {},
): Promise<Pick<SandboxHandle, "network" | "allowedHosts">> {
  const policy = await organizationNetworkPolicy(ctx, organizationId);
  if (!policy.restrictNetwork) return {};
  const repos = await ctx.db
    .select({ repoUrl: repositories.repoUrl })
    .from(repositories)
    .where(eq(repositories.projectId, projectId));
  const adapter = getAdapter(cli);
  const driver = ctx.drivers.get("modal") ?? ctx.drivers.default;
  const { env: resolved } = await resolveAgentEnv(ctx, organizationId, adapter, model, driver, actingUserId, personalCredentialIds);
  const custom = await customProviderRunEnv(ctx, organizationId, cli, model, actingUserId, personalCredentialIds);
  const env = custom ? custom.env : resolved;
  // Keys the model proxy carries are reached through the gateway, so
  // their providers' hosts stay off the list. The same plan the
  // executor makes, from the same driver and environment.
  const proxy = custom ? null : await planModelProxy(ctx, adapter, driver, resolved);
  return {
    network: "restricted",
    allowedHosts: modalRunHosts({
      gatewayUrl: ctx.env.BENTO_MCP_GATEWAY_URL ?? ctx.env.BETTER_AUTH_URL,
      cloneUrls: repos.map((row) => row.repoUrl),
      env,
      ...(custom?.selection?.baseUrl ? { customBaseUrl: custom.selection.baseUrl } : {}),
      ...(proxy?.gatewayBase ? { proxiedKeys: proxy.keys } : {}),
      extraHosts: policy.allowedHosts,
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
 * Adds the hosts of MCP servers to a locked team's allowed sites.
 *
 * Called when the lock is turned on and when a team server is added or
 * enabled while it is on, so the list shows every endpoint the team
 * turned on and a person can take any of them off again. Team servers
 * only: an admin adds those, while any member may add a personal one,
 * and the lock is an admin's to widen. A host the list rules refuse (an
 * IP literal, a name with an underscore) is left off rather than saved
 * as something the field would then refuse. No lock, nothing added.
 */
export async function allowMcpHosts(handle: Db, organizationId: string, urls?: readonly string[]): Promise<void> {
  const [policy] = await handle
    .select({ restrictNetwork: organizationPolicies.restrictNetwork, allowedHosts: organizationPolicies.allowedHosts })
    .from(organizationPolicies)
    .where(eq(organizationPolicies.organizationId, organizationId))
    .limit(1);
  if (!policy?.restrictNetwork) return;
  const sources =
    urls ??
    (
      await handle
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(
          and(
            eq(mcpServers.organizationId, organizationId),
            eq(mcpServers.enabled, true),
            isNull(mcpServers.userId),
          ),
        )
    ).map((row) => row.url);
  const hosts = [...policy.allowedHosts];
  for (const url of sources) {
    const parsed = parseAllowedHost(url);
    if (hosts.length >= MAX_ALLOWED_HOSTS) break;
    if ("host" in parsed && !hosts.includes(parsed.host)) hosts.push(parsed.host);
  }
  if (hosts.length === policy.allowedHosts.length) return;
  await handle
    .update(organizationPolicies)
    .set({ allowedHosts: hosts, updatedAt: new Date() })
    .where(eq(organizationPolicies.organizationId, organizationId));
}
