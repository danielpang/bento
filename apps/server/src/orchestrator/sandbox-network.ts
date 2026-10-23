import { eq } from "drizzle-orm";
import type { AgentCli } from "@bento/core";
import { getAdapter } from "@bento/agents";
import { organizationPolicies, repositories } from "@bento/db";
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
 * On top of what Bento names itself, the sites the team allowed. MCP
 * servers need no entry: the agent reaches them through the gateway,
 * which is on the list, and adding their hosts would let any member who
 * can add a personal server widen every locked run in the team.
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
