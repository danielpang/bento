import { eq } from "drizzle-orm";
import { agentRuns, features } from "@bento/db";
import type { AppContext } from "../context.js";
import { childCardsFor, childCount, MAX_CHILDREN_PER_CARD, parentRefusal } from "../feature-tree.js";
import { queueLinearIssueCreate } from "../orchestrator/linear-sync.js";
import type { ResolvedGrant } from "./grants.js";

/**
 * Bento's own MCP server, which is not a server.
 *
 * Agents already reach the outside world through the gateway with a
 * run-scoped token, so this is the cheapest honest way to give a run a
 * door back into the board: a virtual server id the gateway answers
 * itself instead of proxying. No upstream, no credential, no new token
 * format, and it dies with the run like every other grant.
 *
 * What it exposes is deliberately tiny. The run's own feature is the
 * only card it can touch, and the only thing it can do is add children
 * to it. Everything about who and where comes from the grant, never
 * from the agent:
 *
 * - The agent cannot name a parent, a project, or another card. There
 *   is nothing to pass, so there is nothing to forge.
 * - There is no update and no delete. A tool that could rewrite a card
 *   would make every repository an agent reads a way to rewrite the
 *   board.
 * - Children are filed, never started. They land in the backlog and go
 *   through the ordinary activation path, entitlement checks and all.
 *
 * The judgement about *whether* to split cannot live here. Code cannot
 * tell a large task from a small one, so that gate is written into the
 * tool description and into the stage prompt; the child cap and the
 * no-auto-run rule are what is left when an agent ignores it.
 */

/** The gateway path segment, and the tool name prefix a harness renders. */
export const BENTO_SERVER_ID = "bento";

/**
 * Protocol versions this speaks. A client asking for one of them is
 * answered in its own version; anything else (a client from the
 * future, or a typo) is answered in the newest we know, which is what
 * the spec asks for.
 */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;

/**
 * The efficiency gate, in the agent's own tool list.
 *
 * Stated as a refusal condition rather than an invitation, because the
 * failure this feature can most easily cause is an agent that splits
 * everything it is given into five cards nobody asked for.
 */
const CREATE_CARD_DESCRIPTION = [
  "Split the card you are working into a separate part, filed as its own card in this project.",
  "",
  "Only do this when both are true: the task is genuinely too large for one branch, and dividing it is more efficient than working it yourself (separate sandboxes, smaller context, or parts that can finish independently).",
  "Do not split work whose parts would edit the same files, and do not split a task you could simply do. A card that is one change must end with no parts at all.",
  "",
  "The new card belongs to the card you are working. It starts in the backlog with no agent on it; it does not run until the board starts it. Write the description as a brief for somebody who has not read your card.",
].join("\n");

const TOOLS = [
  {
    name: "create_card",
    title: "Split off a part of this card",
    description: CREATE_CARD_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short title, as it will read on the board." },
        description: {
          type: "string",
          description: "What this part is, and what finishing it means. Written for somebody with no context.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "list_child_cards",
    title: "List the parts already split off",
    description:
      "The cards already split off from the one you are working, with their status. Check this before creating parts if you may have been interrupted: a re-queued run that does not look would file everything twice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** A JSON-RPC answer, plus the HTTP status the gateway sends it with. */
export interface RpcAnswer {
  status: number;
  body: unknown;
}

/** No body at all: a notification, or a response the client did not ask for. */
const ACCEPTED: RpcAnswer = { status: 202, body: null };

/**
 * Handles one JSON-RPC message from a sandbox.
 *
 * Errors are returned as JSON-RPC errors with HTTP 200, which is what
 * the transport asks for: an HTTP status describes the transport, and
 * a client that reads a 400 as "the gateway is broken" retries instead
 * of reading the refusal.
 */
export async function handleBentoRpc(ctx: AppContext, grant: ResolvedGrant, raw: string): Promise<RpcAnswer> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } };
  }
  // Batches were removed in 2025-06-18 and no harness sends one to a
  // two-tool server; saying so beats half-supporting it.
  if (Array.isArray(message)) {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batches are not supported" } } };
  }
  if (!message || typeof message !== "object") {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } } };
  }
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  // A response or a notification: nothing to answer.
  if (typeof method !== "string") return ACCEPTED;
  const isNotification = id === undefined || id === null;

  const reply = (result: unknown): RpcAnswer =>
    isNotification ? ACCEPTED : { status: 200, body: { jsonrpc: "2.0", id, result } };
  const fail = (code: number, text: string): RpcAnswer =>
    isNotification ? ACCEPTED : { status: 200, body: { jsonrpc: "2.0", id, error: { code, message: text } } };

  switch (method) {
    case "initialize": {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const version =
        typeof asked === "string" && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0]!;
      return reply({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "bento", title: "Bento board", version: "1" },
        instructions:
          "The card you are working, from the inside. Use create_card only when the task is too large for one branch and dividing it is more efficient than doing it yourself.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      if (call.name === "create_card") return reply(await createCard(ctx, grant, args));
      if (call.name === "list_child_cards") return reply(await listChildCards(ctx, grant));
      return fail(-32602, `unknown tool: ${String(call.name)}`);
    }
    default:
      // notifications/initialized and friends land here and are simply
      // accepted; anything else is an honest "method not found".
      return isNotification ? ACCEPTED : fail(-32601, `unknown method: ${method}`);
  }
}

/** A tool result the agent reads as prose, refusals included. */
function say(text: string, failed = false): { content: { type: "text"; text: string }[]; isError?: true } {
  return failed ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/**
 * The card the grant's run is working. Everything the tools do is
 * derived from this row, which is why neither tool takes a card id.
 */
async function runFeature(ctx: AppContext, grant: ResolvedGrant) {
  const [row] = await ctx.db
    .select({ feature: features })
    .from(agentRuns)
    .innerJoin(features, eq(features.id, agentRuns.featureId))
    .where(eq(agentRuns.id, grant.runId))
    .limit(1);
  return row?.feature ?? null;
}

async function createCard(ctx: AppContext, grant: ResolvedGrant, args: Record<string, unknown>) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (!title) return say("A card needs a title. Nothing was created.", true);
  if (title.length > MAX_TITLE) return say(`Titles are at most ${MAX_TITLE} characters. Nothing was created.`, true);
  if (description.length > MAX_DESCRIPTION) {
    return say(`Descriptions are at most ${MAX_DESCRIPTION} characters. Nothing was created.`, true);
  }

  const parent = await runFeature(ctx, grant);
  // The card went away mid-run (deleted in another tab). Nothing to
  // parent to, and the run is about to end anyway.
  if (!parent) return say("The card this run belongs to no longer exists, so nothing was created.", true);

  const refusal = await parentRefusal(ctx.db, { parentId: parent.id, projectId: parent.projectId });
  if (refusal) return say(`No card was created: ${refusal}.`, true);

  const [child] = await ctx.db
    .insert(features)
    .values({
      projectId: parent.projectId,
      pipelineId: parent.pipelineId,
      title,
      description,
      parentId: parent.id,
    })
    .returning();
  if (!child) return say("The card could not be saved. Try once more.", true);

  /**
   * The same three things POST /api/features does, because a card is a
   * card however it was filed: it is counted, it is mirrored into
   * Linear if the workspace wants that, and every open board hears
   * about it while the run is still going. Not deferred: the gateway
   * runs outside the tenant transaction, so the insert above has
   * already committed.
   *
   * Notably absent: starting it. Children go through the ordinary
   * activation path, so the plan's allowance and the project's
   * auto-start setting decide when an agent picks one up, exactly as
   * they do for a card a person filed.
   */
  ctx.analytics?.capture({
    event: "feature card created",
    userId: grant.actingUserId,
    organizationId: child.organizationId,
    properties: {
      feature_id: child.id,
      project_id: child.projectId,
      parent_feature_id: parent.id,
      source: "agent",
    },
  });
  await queueLinearIssueCreate(ctx, child);
  ctx.bus.emitBoardEvent({ type: "feature_updated", projectId: child.projectId, featureId: child.id });

  const left = MAX_CHILDREN_PER_CARD - (await childCount(ctx.db, parent.id));
  return say(
    [
      `Created card ${child.id}: ${child.title}`,
      "It is in the backlog of this project, filed under the card you are working. It has no agent on it yet.",
      `You may create ${left} more part${left === 1 ? "" : "s"} of this card.`,
    ].join("\n"),
  );
}

async function listChildCards(ctx: AppContext, grant: ResolvedGrant) {
  const parent = await runFeature(ctx, grant);
  if (!parent) return say("The card this run belongs to no longer exists.", true);
  const children = await childCardsFor(ctx.db, parent.id);
  if (children.length === 0) return say("This card has not been split. No parts exist yet.");
  return say(
    children
      .map(
        (child) =>
          `${child.id} | ${child.status}${child.agentWorking ? " (agent working)" : ""} | ${child.stage ?? "backlog"} | ${child.title}`,
      )
      .join("\n"),
  );
}
