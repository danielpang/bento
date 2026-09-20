import { and, eq, inArray, isNull } from "drizzle-orm";
import { agentRuns, features, pullRequestUpdates, repositories } from "@bento/db";
import type { AppContext } from "../context.js";
import { featurePullRequestTargets } from "../feature-prs.js";
import { childCardsFor, childCount, MAX_CHILDREN_PER_CARD, parentRefusal } from "../feature-tree.js";
import { githubConnectionFor } from "../github.js";
import { cardBranch } from "../orchestrator/branch-rotation.js";
import { queueLinearIssueCreate } from "../orchestrator/linear-sync.js";
import { applyPendingPullRequestUpdates } from "../orchestrator/pull-request-updates.js";
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
 * What it exposes is deliberately small. The run's own feature is the
 * only card it can touch: it can add children to it, and it can say
 * what the card's pull requests should read. Everything about who and
 * where comes from the grant, never from the agent:
 *
 * - The agent cannot name a parent, a project, another card, or a
 *   pull request. There is nothing to pass, so there is nothing to
 *   forge; a repository name is checked against the project's own.
 * - There is no update and no delete of cards. A tool that could
 *   rewrite a card would make every repository an agent reads a way
 *   to rewrite the board.
 * - Children are filed, never started. They land in the backlog and go
 *   through the ordinary activation path, entitlement checks and all.
 * - Pull request text is recorded, and the server writes it to GitHub
 *   with its own connection. No credential reaches the sandbox, and
 *   the only pull requests it can reach are the card's own.
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
/** GitHub's own limit on a pull request title. */
const MAX_PR_TITLE = 256;
/** Under GitHub's limit on a pull request body or comment, with room for the marker. */
const MAX_PR_BODY = 65_000;

const REPOSITORY_ARGUMENT = {
  type: "string",
  description:
    "The repository this is for, by its name in the project. Leave it out to mean every repository the card opens a pull request in, which is right for a project with one.",
};

const SET_PULL_REQUEST_DESCRIPTION = [
  "Set the title and description of the pull request for the card you are working.",
  "",
  "Bento opens and updates the pull request with its own GitHub connection; you have none. If the card already has a pull request, this is applied to it at once. Otherwise it is kept and applied when the branch is next published, which happens when this run finishes if the stage is set to create a pull request.",
  "Calling it again before it is applied replaces the parts you give again and keeps the rest. Write the description for the reviewer: what changed, why, and how to verify it.",
].join("\n");

const ADD_PULL_REQUEST_COMMENT_DESCRIPTION = [
  "Post a comment on the pull request for the card you are working: a review, a question for the reviewer, or a note about what to look at.",
  "",
  "Applied at once if the card already has a pull request, otherwise kept and posted when the branch is next published. Each call is one comment; do not repeat yourself.",
].join("\n");

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
  {
    name: "set_pull_request",
    title: "Set the pull request title and description",
    description: SET_PULL_REQUEST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: `The pull request title, at most ${MAX_PR_TITLE} characters.` },
        description: { type: "string", description: "The pull request description, in Markdown." },
        repository: REPOSITORY_ARGUMENT,
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_pull_request_comment",
    title: "Comment on the pull request",
    description: ADD_PULL_REQUEST_COMMENT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "The comment, in Markdown." },
        repository: REPOSITORY_ARGUMENT,
      },
      required: ["body"],
      additionalProperties: false,
    },
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
          "The card you are working, from the inside. Use create_card only when the task is too large for one branch and dividing it is more efficient than doing it yourself. Use set_pull_request and add_pull_request_comment to say what the card's pull request should read; Bento writes it to GitHub for you.",
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
      if (call.name === "set_pull_request") return reply(await setPullRequest(ctx, grant, args));
      if (call.name === "add_pull_request_comment") return reply(await addPullRequestComment(ctx, grant, args));
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

/**
 * The repositories a call is for, by name: the one named, checked
 * against the project, or every repository the project has. A name
 * that is not there is refused with the names that are, so the agent
 * can fix its call rather than have a row wait forever for a
 * repository that will never publish. A project with no repositories
 * has nothing to open a pull request in, and says so.
 */
async function resolveRepositories(
  ctx: AppContext,
  projectId: string,
  raw: unknown,
): Promise<{ ok: true; repositories: string[] } | { ok: false; reason: string }> {
  const name = typeof raw === "string" ? raw.trim() : "";
  const rows = await ctx.db
    .select({ name: repositories.name })
    .from(repositories)
    .where(eq(repositories.projectId, projectId))
    .orderBy(repositories.position);
  const known = rows.map((r) => r.name);
  if (known.length === 0) return { ok: false, reason: "this project has no repositories, so there is no pull request" };
  if (!name) return { ok: true, repositories: known };
  if (known.includes(name)) return { ok: true, repositories: [name] };
  return { ok: false, reason: `this project's repositories are ${known.join(", ")}, and there is no ${name}` };
}

/**
 * Writes the rows just recorded to the card's pull requests right now,
 * when it has any and the organization has a GitHub connection, and
 * says what happened to each: applied to which pull request, kept
 * for a repository with no pull request yet, or refused by GitHub.
 * The answer is what the agent reads, so it names only the pull
 * requests these rows actually reached.
 */
async function applyNow(
  ctx: AppContext,
  feature: typeof features.$inferSelect,
  what: string,
  rowIds: string[],
): Promise<string> {
  const publisher = await githubConnectionFor(ctx, feature.organizationId);
  const targets = publisher ? await featurePullRequestTargets(ctx.db, feature) : [];
  const applied =
    publisher && targets.length > 0
      ? await applyPendingPullRequestUpdates(ctx.db, publisher, {
          featureId: feature.id,
          branch: cardBranch(feature),
          targets: targets.map((t) => ({ name: t.name, repoUrl: t.repoUrl, prNumber: t.number, url: t.url })),
        })
      : null;

  const rows = await ctx.db.select().from(pullRequestUpdates).where(inArray(pullRequestUpdates.id, rowIds));
  const landed = rows.filter((row) => row.appliedAt !== null);
  const kept = rows.filter((row) => row.appliedAt === null);
  const lines: string[] = [];
  if (landed.length > 0) {
    const urls = landed
      .map((row) => targets.find((t) => t.name === row.repository)?.url)
      .filter((url): url is string => !!url);
    lines.push(`Applied ${what} to ${urls.join(", ")}.`);
  }
  for (const failure of applied?.failures ?? []) {
    lines.push(`GitHub refused the update for ${failure}. It is kept and tried again at the next publish.`);
  }
  const waiting = kept.filter((row) => !applied?.failures.some((f) => f.startsWith(`${row.repository}:`)));
  if (waiting.length > 0) {
    const names = waiting.map((row) => row.repository).join(", ");
    lines.push(
      `Saved ${what} for ${names}: no pull request there yet, so Bento applies it when the branch is next published.`,
    );
  }
  return lines.join("\n");
}

async function setPullRequest(ctx: AppContext, grant: ResolvedGrant, args: Record<string, unknown>) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const body = typeof args.description === "string" ? args.description.trim() : "";
  if (!title && !body) return say("Give a title, a description, or both. Nothing was set.", true);
  if (title.length > MAX_PR_TITLE) {
    return say(`A pull request title is at most ${MAX_PR_TITLE} characters. Nothing was set.`, true);
  }
  if (body.length > MAX_PR_BODY) {
    return say(`A pull request description is at most ${MAX_PR_BODY} characters. Nothing was set.`, true);
  }

  const feature = await runFeature(ctx, grant);
  if (!feature) return say("The card this run belongs to no longer exists, so nothing was set.", true);
  const repos = await resolveRepositories(ctx, feature.projectId, args.repository);
  if (!repos.ok) return say(`Nothing was set: ${repos.reason}.`, true);
  const branch = cardBranch(feature);

  // A second call before the first is applied amends it: the parts
  // given again replace, the parts left out stay. So a title-only
  // follow-up keeps the description from the first call, the same as
  // it would on a pull request that already exists.
  const rowIds: string[] = [];
  for (const repository of repos.repositories) {
    const [pending] = await ctx.db
      .select()
      .from(pullRequestUpdates)
      .where(
        and(
          eq(pullRequestUpdates.runId, grant.runId),
          eq(pullRequestUpdates.repository, repository),
          eq(pullRequestUpdates.branch, branch),
          eq(pullRequestUpdates.kind, "description"),
          isNull(pullRequestUpdates.appliedAt),
        ),
      )
      .limit(1);
    if (pending) {
      await ctx.db
        .update(pullRequestUpdates)
        .set({
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          updatedAt: new Date(),
        })
        .where(eq(pullRequestUpdates.id, pending.id));
      rowIds.push(pending.id);
      continue;
    }
    const [row] = await ctx.db
      .insert(pullRequestUpdates)
      .values({
        runId: grant.runId,
        featureId: feature.id,
        organizationId: feature.organizationId,
        repository,
        branch,
        kind: "description",
        title: title || null,
        body,
      })
      .returning({ id: pullRequestUpdates.id });
    if (row) rowIds.push(row.id);
  }

  const what = title && body ? "the pull request title and description" : title ? "the pull request title" : "the pull request description";
  return say(await applyNow(ctx, feature, what, rowIds));
}

async function addPullRequestComment(ctx: AppContext, grant: ResolvedGrant, args: Record<string, unknown>) {
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!body) return say("A comment needs a body. Nothing was posted.", true);
  if (body.length > MAX_PR_BODY) {
    return say(`A comment is at most ${MAX_PR_BODY} characters. Nothing was posted.`, true);
  }

  const feature = await runFeature(ctx, grant);
  if (!feature) return say("The card this run belongs to no longer exists, so nothing was posted.", true);
  const repos = await resolveRepositories(ctx, feature.projectId, args.repository);
  if (!repos.ok) return say(`Nothing was posted: ${repos.reason}.`, true);
  const branch = cardBranch(feature);

  const rows = await ctx.db
    .insert(pullRequestUpdates)
    .values(
      repos.repositories.map((repository) => ({
        runId: grant.runId,
        featureId: feature.id,
        organizationId: feature.organizationId,
        repository,
        branch,
        kind: "comment" as const,
        body,
      })),
    )
    .returning({ id: pullRequestUpdates.id });

  return say(await applyNow(ctx, feature, "the comment", rows.map((r) => r.id)));
}
