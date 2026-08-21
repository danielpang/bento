import { and, eq, isNull } from "drizzle-orm";
import { mcpCredentials, mcpServers } from "@bento/db";
import { collectExec, type SandboxHandle } from "@bento/sandbox";
import type { AgentAdapter, McpRemoteServer } from "@bento/agents";
import type { AppContext } from "../context.js";
import { mintRunGrant, revokeRunGrant } from "../mcp/grants.js";

/**
 * Attaches the organization's MCP servers to one run.
 *
 * The whole point of the gateway is that this function puts no real
 * credential in the sandbox: it mints a run-scoped token, writes each
 * harness's config pointing every server at the gateway with that
 * token, and returns the argv the CLI needs. The gateway attaches the
 * real credential upstream, and the token dies when the run settles.
 *
 * A worker path, so it reads on the owner pool and filters
 * organization_id by hand, the way resolveAgentEnv does. Nothing here
 * ever fails the run: a server that cannot be attached is left out with
 * a line in the transcript.
 */

const EXEC_TIMEOUT_MS = 30_000;
/** The run's whole budget plus an hour, so a reattach after a restart still authenticates. */
const GRANT_SLACK_MS = 60 * 60_000;

export interface PrepareRunMcpInput {
  runId: string;
  organizationId: string | null;
  /** agent_runs.started_by: whose per-user connections this run may use. */
  actingUserId: string | null;
  adapter: AgentAdapter;
  handle: SandboxHandle;
  restrictNetwork: boolean;
  /** Absolute container paths mounted read-only, from agentAuthMounts. */
  mountedConfigPaths: string[];
  say: (text: string) => Promise<void>;
}

export async function prepareRunMcp(
  ctx: AppContext,
  input: PrepareRunMcpInput,
): Promise<{ extraArgs: string[] }> {
  const none = { extraArgs: [] as string[] };
  const capability = input.adapter.mcp;
  if (!capability) {
    // No note for tools nobody expected to support MCP, only when the
    // org actually has servers this tool will silently lack.
    if (await orgHasEnabledServers(ctx, input.organizationId)) {
      await input.say(
        `${input.adapter.cli} does not support remote MCP servers yet, so this organization's MCP servers are not attached to this run.`,
      );
    }
    return none;
  }
  if (ctx.driver.provider === "local-process") {
    if (await orgHasEnabledServers(ctx, input.organizationId)) {
      await input.say(
        "MCP servers are not attached when agents run as a local process, because their config would overwrite your own. Use the Docker driver to attach them.",
      );
    }
    return none;
  }
  if (input.restrictNetwork) {
    if (await orgHasEnabledServers(ctx, input.organizationId)) {
      await input.say(
        "This organization restricts sandbox network access, so its MCP servers are not attached to this run.",
      );
    }
    return none;
  }

  const gatewayBase = resolveGatewayBase(ctx);
  if (!gatewayBase) {
    if (await orgHasEnabledServers(ctx, input.organizationId)) {
      await input.say(
        "MCP servers are configured, but this deployment has no gateway URL a sandbox can reach. Set BENTO_MCP_GATEWAY_URL.",
      );
    }
    return none;
  }

  // Writing a config into a path mounted read-only from the host would
  // fail the exec; skip the adapter rather than half-attach.
  const renderPaths = capability.renderConfig([]).map((f) => f.path);
  const collision = renderPaths.find((path) => input.mountedConfigPaths.some((m) => pathWithin(path, m)));
  if (collision) {
    if (await orgHasEnabledServers(ctx, input.organizationId)) {
      await input.say(
        `MCP servers are not attached: ${input.adapter.cli}'s config path is mounted read-only from your machine on this run.`,
      );
    }
    return none;
  }

  const servers = await ctx.db
    .select()
    .from(mcpServers)
    .where(and(orgFilter(input.organizationId), eq(mcpServers.enabled, true)));
  if (servers.length === 0) {
    // Overwrite any config a previous run left in this (per-feature,
    // reused) sandbox, so a removed server does not linger.
    await writeConfigs(ctx, input.handle, capability.renderConfig([]));
    return none;
  }

  const attached: McpRemoteServer[] = [];
  for (const server of servers) {
    const usable = await credentialUsable(ctx, server, input.actingUserId);
    if (!usable.ok) {
      if (usable.note) await input.say(usable.note);
      continue;
    }
    // An sse-transport server is reached at the gateway's /sse endpoint,
    // where the endpoint event and message path live; a streamable-HTTP
    // server is reached at the base path.
    const gatewayPath =
      server.transport === "sse"
        ? `${gatewayBase}/api/mcp-gateway/${server.id}/sse`
        : `${gatewayBase}/api/mcp-gateway/${server.id}`;
    attached.push({
      slug: server.slug,
      url: gatewayPath,
      transport: server.transport,
      headers: {},
    });
  }

  // No server attached (all per-user with no credential, say): clear any
  // stale config and mint no grant. The resume path keys the MCP flags
  // off a live grant, so minting one here would make a resumed run add
  // --mcp-config that the first run never had, and the session would
  // diverge.
  if (attached.length === 0) {
    await writeConfigs(ctx, input.handle, capability.renderConfig([]));
    return none;
  }

  const token = await mintRunGrant(ctx, {
    runId: input.runId,
    organizationId: input.organizationId,
    actingUserId: input.actingUserId,
    serverIds: servers.filter((s) => attached.some((a) => a.slug === s.slug)).map((s) => s.id),
    ttlMs: ctx.env.BENTO_RUN_TIMEOUT_MIN * 60_000 + GRANT_SLACK_MS,
  });
  for (const server of attached) {
    server.headers.Authorization = `Bearer ${token}`;
  }

  // If the config could not be written, the agent has no file to read, so
  // do not hand it the flags. Revoke the grant so a resume does not try
  // to reattach MCP either.
  const written = await writeConfigs(ctx, input.handle, capability.renderConfig(attached));
  if (!written) {
    await revokeRunGrant(ctx, input.runId);
    await input.say(
      `Could not write the MCP configuration into the sandbox, so ${input.adapter.cli}'s MCP servers are not attached to this run.`,
    );
    return none;
  }
  return { extraArgs: capability.extraArgs?.() ?? [] };
}

/** Whether the org has any enabled server, for deciding to explain a skip. */
async function orgHasEnabledServers(ctx: AppContext, organizationId: string | null): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(orgFilter(organizationId), eq(mcpServers.enabled, true)))
    .limit(1);
  return Boolean(row);
}

type CredentialCheck = { ok: true } | { ok: false; note: string | null };

async function credentialUsable(
  ctx: AppContext,
  server: typeof mcpServers.$inferSelect,
  actingUserId: string | null,
): Promise<CredentialCheck> {
  if (server.authType === "none") return { ok: true };

  const perUser = server.authType === "oauth" && server.credentialScope === "user";
  if (perUser) {
    if (!actingUserId) {
      // Auto-started runs (a gate evaluator, a judge) have no person to
      // act as, so a per-user server cannot be attached. Silent: no user
      // is present to read a note or act on it.
      return { ok: false, note: null };
    }
    const [row] = await ctx.db
      .select({ id: mcpCredentials.id })
      .from(mcpCredentials)
      .where(and(eq(mcpCredentials.serverId, server.id), eq(mcpCredentials.userId, actingUserId)))
      .limit(1);
    if (!row) {
      return {
        ok: false,
        note: `You have not connected ${server.name}, so it is not available to this run. Connect it under Settings, MCP.`,
      };
    }
    return { ok: true };
  }

  const [row] = await ctx.db
    .select({ id: mcpCredentials.id })
    .from(mcpCredentials)
    .where(and(eq(mcpCredentials.serverId, server.id), isNull(mcpCredentials.userId)))
    .limit(1);
  if (!row) {
    return { ok: false, note: `${server.name} has no credential stored, so it is not attached to this run.` };
  }
  return { ok: true };
}

/** Writes each config file into the sandbox. Returns false if any write failed. */
async function writeConfigs(
  ctx: AppContext,
  handle: SandboxHandle,
  files: { path: string; content: string }[],
): Promise<boolean> {
  for (const file of files) {
    const dir = file.path.replace(/\/[^/]+$/, "");
    const b64 = Buffer.from(file.content, "utf8").toString("base64");
    // The token rides the file content through argv, never opts.env:
    // the sprite driver leaks env into the exec URL, and files do not.
    const script = `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(file.path)} && chmod 600 ${shellQuote(file.path)}`;
    const result = await collectExec(ctx.driver.exec(handle, ["sh", "-c", script], { timeoutMs: EXEC_TIMEOUT_MS }));
    if (result.exitCode !== 0) {
      console.error(`could not write ${file.path} into the sandbox (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
      return false;
    }
  }
  return true;
}

/**
 * The gateway base a sandbox writes into its config. A Docker sandbox
 * reaches the host loopback as host.docker.internal, so a localhost base
 * is rewritten to it; an explicit BENTO_MCP_GATEWAY_URL is always
 * honored as given. Returns null when the resolved base is one the
 * sandbox cannot reach (a sprite on a loopback base).
 */
export function resolveGatewayBase(ctx: AppContext): string | null {
  const base = (ctx.env.BENTO_MCP_GATEWAY_URL ?? ctx.env.BETTER_AUTH_URL).replace(/\/$/, "");
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return null;
  }
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLoopback) return base;
  if (ctx.env.BENTO_MCP_GATEWAY_URL) return base; // Operator said so explicitly.
  if (ctx.driver.provider === "docker") {
    return base.replace(/\/\/(localhost|127\.0\.0\.1|\[::1\])/, "//host.docker.internal");
  }
  // A sprite (or any remote sandbox) cannot reach the server's own
  // loopback; the caller turns this into a transcript note.
  return null;
}

function orgFilter(organizationId: string | null) {
  return organizationId ? eq(mcpServers.organizationId, organizationId) : isNull(mcpServers.organizationId);
}

/** True when `path` is `mount` itself or sits under it. */
function pathWithin(path: string, mount: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return norm(path) === norm(mount) || norm(path).startsWith(`${norm(mount)}/`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
