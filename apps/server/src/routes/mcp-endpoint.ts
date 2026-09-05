import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { agentRuns, featureEvents, features, pipelines, projects, stages } from "@bento/db";
import type { AppContext } from "../context.js";
import { featurePullRequestTargets } from "../feature-prs.js";
import {
  connectionProjectFilter,
  projectForConnection,
  recordConnectionUse,
  resolveConnection,
  type ResolvedConnection,
} from "../mcp/connections.js";
import { requestOrigin } from "../mcp/oauth-as.js";
import { activationRefusal, advanceFeature } from "../orchestrator/gate-evaluator.js";
import { queueLinearIssueCreate } from "../orchestrator/linear-sync.js";

/**
 * Bento's own MCP server: outside agents connect here to create cards
 * and read their progress. The mirror image of the gateway, and mounted
 * the same way: the caller is an agent holding a connection token, not
 * a session, so this sits outside the actor and tenant middleware, runs
 * every query by hand on the owner pool filtered by the connection's
 * scope, and answers a missing or bad token with 401 plus resource
 * metadata so Claude and Cursor start OAuth. Tool refusals inside an
 * authenticated call stay the same "not found" the rest of the API
 * speaks.
 *
 * The transport is Streamable HTTP in its stateless shape: each POST
 * carries one JSON-RPC message and is answered with JSON. No session id
 * is issued, so a lost process loses nothing, and GET (the
 * server-initiated stream) answers 405, which the spec allows for a
 * server with nothing to push. The protocol surface is hand-rolled for
 * the same reason the gateway's proxying is: four methods do not earn a
 * protocol dependency.
 */

const BODY_LIMIT = 1024 * 1024;

/** The spec revisions this server knows. An unknown ask answers the newest. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** 30 requests per 10 seconds per connection, the gateway's budget. */
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_PER_MS = 3 / 1000;
const buckets = new Map<string, { tokens: number; at: number }>();

function takeToken(connectionId: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(connectionId) ?? { tokens: BUCKET_CAPACITY, at: now };
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + (now - bucket.at) * BUCKET_REFILL_PER_MS);
  bucket.at = now;
  if (bucket.tokens < 1) {
    buckets.set(connectionId, bucket);
    return false;
  }
  bucket.tokens -= 1;
  if (bucket.tokens >= BUCKET_CAPACITY - 1) buckets.delete(connectionId);
  else buckets.set(connectionId, bucket);
  return true;
}

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/** A tool outcome the caller should read as failure, per the MCP spec. */
function toolRefusal(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function toolResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** The same words the route checks use, for the same probe resistance. */
const NOT_FOUND = "not found";

const TOOLS = [
  {
    name: "list_projects",
    description:
      "List the Bento projects this connection can reach. Features are created inside a project, so call this first to find the projectId to use.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_feature",
    description:
      "Create a feature card on a Bento project's board. The card lands in the backlog unless start is true, which moves it into the first pipeline stage and lets Bento's agents pick it up. Returns the new feature's id; track it with get_feature_status.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project to create the feature in, from list_projects." },
        title: { type: "string", description: "Short imperative title for the card." },
        description: {
          type: "string",
          description: "What to build and why, in as much detail as is known. Markdown is fine.",
        },
        start: {
          type: "boolean",
          description: "Move the card straight into the first pipeline stage instead of the backlog.",
        },
      },
      required: ["projectId", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "get_feature_status",
    description:
      "Read one feature's progress: its status, current pipeline stage, latest agent run, pull requests, and recent history.",
    inputSchema: {
      type: "object",
      properties: {
        featureId: {
          type: "string",
          description: "The feature to read, from create_feature, list_features, or search_features.",
        },
      },
      required: ["featureId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_features",
    description: "List a project's feature cards with their status and current stage, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "The project whose board to list, from list_projects." },
        status: {
          type: "string",
          enum: ["backlog", "active", "gated", "done", "cancelled"],
          description: "Only cards in this status.",
        },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_features",
    description:
      "Find feature cards by words in their title or description, across every project this connection can reach, and read the status and stage of each match. Use this when you know roughly what a card is about but not its id or which project it is on; use get_feature_status for the full detail of one card.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words to look for in a card's title or description. Case insensitive.",
        },
        projectId: {
          type: "string",
          description: "Only search this project, from list_projects. Omit to search every project in reach.",
        },
        status: {
          type: "string",
          enum: ["backlog", "active", "gated", "done", "cancelled"],
          description: "Only cards in this status.",
        },
        limit: {
          type: "number",
          description: "How many matches to return, 1 to 100. Defaults to 25, most recently updated first.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const createFeatureArgs = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(500),
  description: z.string().max(20000).default(""),
  start: z.boolean().default(false),
});

const getFeatureStatusArgs = z.object({ featureId: z.string() });

const listFeaturesArgs = z.object({
  projectId: z.string(),
  status: z.enum(["backlog", "active", "gated", "done", "cancelled"]).optional(),
});

const searchFeaturesArgs = z.object({
  query: z.string().min(1).max(200),
  projectId: z.string().optional(),
  status: z.enum(["backlog", "active", "gated", "done", "cancelled"]).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export function mcpEndpointRoutes(ctx: AppContext) {
  const routes = new Hono();
  const notFound = (c: Context) => c.json({ error: NOT_FOUND }, 404);

  function unauthorized(c: Context) {
    const origin = requestOrigin(c, ctx.env.BETTER_AUTH_URL);
    c.header(
      "WWW-Authenticate",
      `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    return c.json({ error: "unauthorized" }, 401);
  }

  async function authenticate(c: Context): Promise<ResolvedConnection | null> {
    const auth = c.req.header("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return null;
    return resolveConnection(ctx, auth.slice("Bearer ".length).trim());
  }

  routes.post("/", async (c) => {
    const conn = await authenticate(c);
    if (!conn) return unauthorized(c);
    if (!takeToken(conn.id)) return c.json({ error: "slow down" }, 429);
    recordConnectionUse(ctx, conn.id);

    const raw = await readBody(c);
    if (raw === null) return c.json({ error: "body too large" }, 413);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return c.json(rpcError(null, -32700, "the body is not JSON"), 200);
    }
    // JSON-RPC batching was removed in the 2025-06-18 revision and no
    // common client sends one; refusing keeps every response one message.
    if (Array.isArray(message) || typeof message !== "object" || message === null) {
      return c.json(rpcError(null, -32600, "send one JSON-RPC message per request"), 200);
    }

    // Notifications and client-side results carry no id to answer;
    // accept and drop them, as the stateless shape allows.
    const id = message.id;
    const isRequest = typeof message.method === "string" && (typeof id === "string" || typeof id === "number");
    if (!isRequest) return c.body(null, 202);

    const method = message.method as string;
    const params = (message.params ?? {}) as Record<string, unknown>;
    try {
      switch (method) {
        case "initialize": {
          const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
          return c.json(
            rpcResult(id as JsonRpcId, {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "bento", title: "Bento", version: "1.0.0" },
              instructions:
                "Bento runs coding agents against feature cards on a project board. Use list_projects to see where you can work, create_feature to put a card on a board, and get_feature_status to follow what happens to it.",
            }),
            200,
          );
        }
        case "ping":
          return c.json(rpcResult(id as JsonRpcId, {}), 200);
        case "tools/list":
          return c.json(rpcResult(id as JsonRpcId, { tools: TOOLS }), 200);
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const outcome = await callTool(ctx, conn, name, args);
          if (outcome === undefined) {
            return c.json(rpcError(id as JsonRpcId, -32602, `unknown tool: ${name || "(unnamed)"}`), 200);
          }
          return c.json(rpcResult(id as JsonRpcId, outcome), 200);
        }
        default:
          return c.json(rpcError(id as JsonRpcId, -32601, `unknown method: ${method}`), 200);
      }
    } catch (err) {
      console.error(`bento MCP server failed on ${method}:`, err);
      return c.json(rpcError(id as JsonRpcId, -32603, "something went wrong; try again"), 200);
    }
  });

  // No server-initiated stream and no session to end: a stateless
  // server answers 405 for both, which Streamable HTTP clients accept.
  routes.get("/", async (c) => {
    const conn = await authenticate(c);
    if (!conn) return unauthorized(c);
    c.header("allow", "POST");
    return c.json({ error: "this MCP server does not open a server stream" }, 405);
  });
  routes.delete("/", async (c) => {
    const conn = await authenticate(c);
    if (!conn) return unauthorized(c);
    c.header("allow", "POST");
    return c.json({ error: "this MCP server is stateless; there is no session to end" }, 405);
  });

  return routes;
}

/**
 * Reads the JSON-RPC body, capped while reading, for the same reason
 * the gateway does it this way: content-length is attacker controlled
 * and a chunked body carries none.
 */
async function readBody(c: Context): Promise<string | null> {
  const body = c.req.raw.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BODY_LIMIT) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Runs one tool. Returns undefined for a name this server does not
 * have (a protocol error), and a result with isError for a refusal the
 * calling agent should read and act on.
 */
async function callTool(
  ctx: AppContext,
  conn: ResolvedConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_projects":
      return listProjects(ctx, conn);
    case "create_feature":
      return createFeature(ctx, conn, args);
    case "get_feature_status":
      return getFeatureStatus(ctx, conn, args);
    case "list_features":
      return listFeatures(ctx, conn, args);
    case "search_features":
      return searchFeatures(ctx, conn, args);
    default:
      return undefined;
  }
}

async function listProjects(ctx: AppContext, conn: ResolvedConnection) {
  const rows = await ctx.db
    .select({ id: projects.id, name: projects.name, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(connectionProjectFilter(conn))
    .orderBy(asc(projects.createdAt));
  return toolResult({ projects: rows });
}

async function createFeature(ctx: AppContext, conn: ResolvedConnection, args: Record<string, unknown>) {
  const parsed = createFeatureArgs.safeParse(args);
  if (!parsed.success) return toolRefusal(argsProblem(parsed.error));
  const project = await projectForConnection(ctx, conn, parsed.data.projectId);
  if (!project) return toolRefusal(NOT_FOUND);
  const [pipeline] = await ctx.db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.projectId, project.id))
    .limit(1);
  if (!pipeline) return toolRefusal("this project has no pipeline yet; open it in Bento once to set one up");

  const [feature] = await ctx.db
    .insert(features)
    .values({
      projectId: project.id,
      pipelineId: pipeline.id,
      title: parsed.data.title,
      description: parsed.data.description,
    })
    .returning();
  if (!feature) return toolRefusal("something went wrong saving the card; try again");
  ctx.analytics?.capture({
    event: "feature card created",
    userId: conn.ownerId,
    organizationId: feature.organizationId,
    properties: { feature_id: feature.id, project_id: feature.projectId, source: "mcp" },
  });
  await queueLinearIssueCreate(ctx, feature);

  let started = false;
  let note: string | null = null;
  if (parsed.data.start) {
    // The Slack-mention path: a plan refusal leaves the card in the
    // backlog with the reason, rather than failing the create.
    note = await activationRefusal(ctx, feature);
    if (!note) {
      await advanceFeature(ctx, feature.id, "manual", conn.ownerId);
      started = true;
    }
  }
  return toolResult({
    featureId: feature.id,
    projectId: feature.projectId,
    title: feature.title,
    status: started ? "active" : feature.status,
    inBacklog: !started,
    ...(note ? { note } : {}),
  });
}

async function getFeatureStatus(ctx: AppContext, conn: ResolvedConnection, args: Record<string, unknown>) {
  const parsed = getFeatureStatusArgs.safeParse(args);
  if (!parsed.success) return toolRefusal(argsProblem(parsed.error));
  const feature = await featureForConnection(ctx, conn, parsed.data.featureId);
  if (!feature) return toolRefusal(NOT_FOUND);

  const stageRows = await ctx.db
    .select({ id: stages.id, name: stages.name, position: stages.position })
    .from(stages)
    .where(eq(stages.pipelineId, feature.pipelineId))
    .orderBy(asc(stages.position));
  const stageName = (id: string | null) => stageRows.find((s) => s.id === id)?.name ?? null;
  const current = feature.currentStageId ? stageRows.find((s) => s.id === feature.currentStageId) : undefined;

  const [latestRun] = await ctx.db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      kind: agentRuns.kind,
      queuedAt: agentRuns.queuedAt,
      endedAt: agentRuns.endedAt,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .where(eq(agentRuns.featureId, feature.id))
    .orderBy(desc(agentRuns.queuedAt))
    .limit(1);

  const pullRequests = await featurePullRequestTargets(ctx.db, feature);
  const history = await ctx.db
    .select()
    .from(featureEvents)
    .where(eq(featureEvents.featureId, feature.id))
    .orderBy(desc(featureEvents.at))
    .limit(10);

  return toolResult({
    id: feature.id,
    projectId: feature.projectId,
    title: feature.title,
    description: feature.description,
    status: feature.status,
    stage: current
      ? { id: current.id, name: current.name, position: stageRows.indexOf(current) + 1, of: stageRows.length }
      : null,
    inBacklog: feature.currentStageId === null && feature.status === "backlog",
    latestRun: latestRun ?? null,
    pullRequests: pullRequests.map((pr) => ({ repoUrl: pr.repoUrl, number: pr.number, url: pr.url })),
    recentHistory: history.map((event) => ({
      at: event.at,
      kind: event.kind,
      trigger: event.trigger,
      ...(event.kind === "stage_moved"
        ? { fromStage: stageName(event.fromStageId), toStage: stageName(event.toStageId) }
        : { fromStatus: event.fromStatus, toStatus: event.toStatus }),
    })),
  });
}

async function listFeatures(ctx: AppContext, conn: ResolvedConnection, args: Record<string, unknown>) {
  const parsed = listFeaturesArgs.safeParse(args);
  if (!parsed.success) return toolRefusal(argsProblem(parsed.error));
  const project = await projectForConnection(ctx, conn, parsed.data.projectId);
  if (!project) return toolRefusal(NOT_FOUND);

  const rows = await ctx.db
    .select()
    .from(features)
    .where(
      and(
        eq(features.projectId, project.id),
        ...(parsed.data.status ? [eq(features.status, parsed.data.status)] : []),
      ),
    )
    .orderBy(desc(features.createdAt));
  const stageIds = [...new Set(rows.map((row) => row.currentStageId).filter((id): id is string => id !== null))];
  const stageRows = stageIds.length
    ? await ctx.db.select({ id: stages.id, name: stages.name }).from(stages).where(inArray(stages.id, stageIds))
    : [];
  return toolResult({
    features: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      stage: stageRows.find((s) => s.id === row.currentStageId)?.name ?? null,
      prNumber: row.prNumber,
      createdAt: row.createdAt,
    })),
  });
}

/**
 * Cards matching words in their title or description, across the
 * connection's whole scope unless one project is named.
 *
 * The scope filter is the join condition rather than a post-filter, so
 * a card in a project this connection cannot reach is never read, let
 * alone returned. Ordered by most recently updated, because someone
 * searching for a card is nearly always looking for the one that moved.
 */
async function searchFeatures(ctx: AppContext, conn: ResolvedConnection, args: Record<string, unknown>) {
  const parsed = searchFeaturesArgs.safeParse(args);
  if (!parsed.success) return toolRefusal(argsProblem(parsed.error));

  // A named project is resolved through the scope first, so asking about
  // one out of reach reads as not found rather than as no matches.
  let onlyProject: string | undefined;
  if (parsed.data.projectId !== undefined) {
    const project = await projectForConnection(ctx, conn, parsed.data.projectId);
    if (!project) return toolRefusal(NOT_FOUND);
    onlyProject = project.id;
  }

  const term = `%${likeEscape(parsed.data.query)}%`;
  const rows = await ctx.db
    .select({ feature: features, projectName: projects.name })
    .from(features)
    .innerJoin(projects, eq(projects.id, features.projectId))
    .where(
      and(
        connectionProjectFilter(conn),
        or(ilike(features.title, term), ilike(features.description, term)),
        ...(onlyProject ? [eq(features.projectId, onlyProject)] : []),
        ...(parsed.data.status ? [eq(features.status, parsed.data.status)] : []),
      ),
    )
    .orderBy(desc(features.updatedAt))
    .limit(parsed.data.limit);

  const stageIds = [
    ...new Set(rows.map((row) => row.feature.currentStageId).filter((id): id is string => id !== null)),
  ];
  const stageRows = stageIds.length
    ? await ctx.db.select({ id: stages.id, name: stages.name }).from(stages).where(inArray(stages.id, stageIds))
    : [];

  return toolResult({
    query: parsed.data.query,
    matches: rows.length,
    // Said plainly, because a full page of results and a complete set
    // look identical to a caller that cannot see the limit.
    truncated: rows.length === parsed.data.limit,
    features: rows.map(({ feature, projectName }) => ({
      id: feature.id,
      title: feature.title,
      projectId: feature.projectId,
      projectName,
      status: feature.status,
      stage: stageRows.find((s) => s.id === feature.currentStageId)?.name ?? null,
      inBacklog: feature.currentStageId === null && feature.status === "backlog",
      prNumber: feature.prNumber,
      updatedAt: feature.updatedAt,
    })),
  });
}

/**
 * A search term is data, not pattern syntax: without this a query
 * containing % or _ would match far more than it says, and a trailing
 * backslash would be a malformed pattern.
 */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The feature when its project is in the connection's scope, else null. */
async function featureForConnection(ctx: AppContext, conn: ResolvedConnection, featureId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(featureId)) return null;
  const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId)).limit(1);
  if (!feature) return null;
  return (await projectForConnection(ctx, conn, feature.projectId)) ? feature : null;
}

/** A validation failure as the fields it happened on, for the calling agent. */
function argsProblem(error: z.ZodError): string {
  const lines = error.issues.slice(0, 3).map((issue) => {
    const field = issue.path.join(".");
    return field ? `${field}: ${issue.message}` : issue.message;
  });
  return `invalid arguments. ${lines.join("; ")}`;
}
