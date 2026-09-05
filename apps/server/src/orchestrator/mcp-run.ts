import { and, eq, isNull, or } from "drizzle-orm";
import { mcpCredentials, mcpServers } from "@bento/db";
import { collectExec, type SandboxHandle } from "@bento/sandbox";
import type { AgentAdapter, McpRemoteServer } from "@bento/agents";
import type { AppContext } from "../context.js";
import { BENTO_SERVER_ID } from "../mcp/bento-tools.js";
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
 *
 * One of the servers is Bento itself (see mcp/bento-tools.ts), which
 * has no row, no upstream and no credential: it is how the agent
 * working a card can file the parts of a task too large for one
 * branch. It rides the same grant as everything else, so a harness
 * with no MCP support, an organization that restricts sandbox network
 * access, and the local-process driver each run without it, which is
 * the same limitation their MCP servers already have. It is also
 * behind the beta flag, decided by the caller.
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
  /**
   * Whether this run may have Bento's own tools. Unfinished product,
   * so it is the beta flag, decided by the caller (which knows the
   * project) rather than read here.
   */
  cardTools: boolean;
  say: (text: string) => Promise<void>;
}

export async function prepareRunMcp(
  ctx: AppContext,
  input: PrepareRunMcpInput,
): Promise<{ extraArgs: string[]; cardTools: boolean }> {
  const none = { extraArgs: [] as string[], cardTools: false };
  const capability = input.adapter.mcp;
  // Whether this run has any server to attach at all: team servers, plus
  // the acting member's own. Decides only whether a skip is worth a note.
  const hasServers = () => hasEnabledServers(ctx, input.organizationId, input.actingUserId);
  if (!capability) {
    // No note for tools nobody expected to support MCP, only when there
    // actually are servers this tool will silently lack.
    if (await hasServers()) {
      await input.say(
        `${input.adapter.cli} does not support remote MCP servers yet, so this organization's MCP servers are not attached to this run.`,
      );
    }
    return none;
  }
  if (ctx.driver.provider === "local-process") {
    if (await hasServers()) {
      await input.say(
        "MCP servers are not attached when agents run as a local process, because their config would overwrite your own. Use the Docker driver to attach them.",
      );
    }
    return none;
  }
  if (input.restrictNetwork) {
    if (await hasServers()) {
      await input.say(
        "This organization restricts sandbox network access, so its MCP servers are not attached to this run.",
      );
    }
    return none;
  }

  const gatewayBase = resolveGatewayBase(ctx);
  if (!gatewayBase) {
    if (await hasServers()) {
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
    if (await hasServers()) {
      await input.say(
        `MCP servers are not attached: ${input.adapter.cli}'s config path is mounted read-only from your machine on this run.`,
      );
    }
    return none;
  }

  // The run draws from the team registry plus the acting member's own
  // personal servers. An auto-started run has no acting member, so it
  // gets team servers only.
  const servers = await ctx.db
    .select()
    .from(mcpServers)
    .where(
      and(
        orgFilter(input.organizationId),
        eq(mcpServers.enabled, true),
        input.actingUserId
          ? or(isNull(mcpServers.userId), eq(mcpServers.userId, input.actingUserId))
          : isNull(mcpServers.userId),
      ),
    );

  const attached: McpRemoteServer[] = [];
  const attachedIds: string[] = [];

  /**
   * Bento's own tools, on every run that can have any MCP at all and
   * whose team is on the beta flag.
   *
   * Not a row in mcp_servers: it is not an upstream, it has no
   * credential, and no admin configured it. The gateway answers this
   * id itself. It goes first so it reads first in the harness's tool
   * list, and it is what lets the agent working a card file the parts
   * of a task too large for one branch.
   *
   * Flagged with the console it belongs to, not separately: an agent
   * that can split a card for a team whose board cannot show the group
   * has made work nobody can see the shape of.
   */
  if (input.cardTools) {
    attached.push({
      slug: BENTO_SERVER_ID,
      url: `${gatewayBase}/api/mcp-gateway/${BENTO_SERVER_ID}`,
      transport: "http",
      headers: {},
    });
    attachedIds.push(BENTO_SERVER_ID);
  }

  // A personal slug may equal a team slug, and one slug is one tool
  // name to the harness. The team's server wins: the registry is what
  // admins govern, and a member's runs saying so in the transcript
  // beats their config silently shadowing it.
  const teamSlugs = new Set(servers.filter((s) => !s.userId).map((s) => s.slug));
  for (const server of servers) {
    // A server named "bento" would take the tool names the board's own
    // tools answer on, which is the one shadowing that could reach the
    // cards. Only a conflict when ours is actually attached: the slug
    // is a tool name in the harness, not a gateway path, so a run
    // without the card tools has nothing to collide with.
    if (input.cardTools && server.slug === BENTO_SERVER_ID) {
      await input.say(
        `The server ${server.name} uses the name bento, which belongs to Bento's own tools, so it is not attached to this run.`,
      );
      continue;
    }
    if (server.userId && teamSlugs.has(server.slug)) {
      await input.say(
        `Your personal server ${server.name} shares its tool name with a team server, so the team's is used.`,
      );
      continue;
    }
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
    attachedIds.push(server.id);
  }

  /**
   * Nothing to attach: no card tools, and no server the run can use
   * (all per-user with no credential, say). Clear any config a previous
   * run left in this per-feature sandbox and mint no grant. The resume
   * path keys the MCP flags off a live grant, so minting one here would
   * make a resumed run add --mcp-config that the first run never had,
   * and the session would diverge.
   */
  if (attached.length === 0) {
    await writeConfigs(ctx, input.handle, capability.renderConfig([]));
    return none;
  }

  const token = await mintRunGrant(ctx, {
    runId: input.runId,
    organizationId: input.organizationId,
    actingUserId: input.actingUserId,
    serverIds: attachedIds,
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
  return { extraArgs: capability.extraArgs?.() ?? [], cardTools: attachedIds.includes(BENTO_SERVER_ID) };
}

/** Whether this run has any enabled server: the team's, plus the acting member's own. */
async function hasEnabledServers(
  ctx: AppContext,
  organizationId: string | null,
  actingUserId: string | null,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(
      and(
        orgFilter(organizationId),
        eq(mcpServers.enabled, true),
        actingUserId
          ? or(isNull(mcpServers.userId), eq(mcpServers.userId, actingUserId))
          : isNull(mcpServers.userId),
      ),
    )
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

  // A personal server's credential is always its owner's own row, and
  // the query above only returns personal servers owned by the acting
  // user, so the per-user branch covers both shapes.
  const perUser =
    server.userId !== null || (server.authType === "oauth" && server.credentialScope === "user");
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
