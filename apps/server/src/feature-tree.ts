import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { agentRuns, featurePullRequests, features, stages, type Db } from "@bento/db";
import { ACTIVE_RUN_STATUSES } from "./orchestrator/start-run.js";

/**
 * Cards that spawned other cards.
 *
 * A large task stays one card and may grow children: `features.parent_id`
 * is the whole model. This module holds the rules that a column cannot
 * state on its own, so the HTTP route and the agent-facing MCP tool
 * refuse the same things in the same words.
 *
 * The edge means "that card spawned this one". It is not a dependency,
 * not a blocker, and not an ordering: every child is an ordinary card
 * with its own branch, sandbox, pipeline and 24 hour clock.
 */

/**
 * How many children one card may spawn.
 *
 * A backstop, not a design target. Code cannot judge whether a task
 * deserves splitting (that gate is written into the prompt), so this is
 * the mechanical limit on an agent that has decided everything is an
 * epic, or on one that has been talked into it by injected text in a
 * repository it read.
 */
export const MAX_CHILDREN_PER_CARD = 20;

/**
 * How deep a chain of spawns may go, counting the root as depth 1.
 *
 * A child may itself split, which the investigation allows, but the
 * related view shows one level, so a deeper chain is work nobody can
 * see the shape of. The walk that enforces it is also what makes a
 * cycle terminate: v1 only ever sets `parent_id` on rows it is
 * inserting, so a cycle cannot be created through any door here, but a
 * bounded walk means a row that acquired one some other way costs a
 * refusal rather than a hung request.
 */
export const MAX_PARENT_DEPTH = 3;

export const PARENT_NOT_FOUND = "that card is not in this project";
export const PARENT_TOO_DEEP = `cards can only be split ${MAX_PARENT_DEPTH} levels deep`;
export const PARENT_FULL = `that card already has ${MAX_CHILDREN_PER_CARD} children, which is the limit`;

/**
 * Whether a card may be given this parent, in the words the caller
 * answers with. Null means yes.
 *
 * The caller has already decided that the *caller* may see the parent
 * (an access helper on the route, the run's own grant on the MCP tool).
 * What is checked here is the shape of the relationship:
 *
 * - **Same project.** A group that spans projects would break the board
 *   query, the related view, and the tenant column every card inherits
 *   from its project. Said as "not in this project" rather than
 *   "forbidden", because from the caller's side those are the same fact.
 * - **Bounded depth**, which also bounds the walk.
 * - **Room left**, so the cap holds wherever a child is filed from.
 */
export async function parentRefusal(
  db: Db,
  input: { parentId: string; projectId: string },
): Promise<string | null> {
  let currentId: string | null = input.parentId;
  let depth = 0;
  while (currentId) {
    depth += 1;
    // The chain is at the limit before this child is even counted, so
    // the comparison is against the depth a new row would take.
    if (depth >= MAX_PARENT_DEPTH) return PARENT_TOO_DEEP;
    const [row]: { parentId: string | null; projectId: string }[] = await db
      .select({ parentId: features.parentId, projectId: features.projectId })
      .from(features)
      .where(eq(features.id, currentId))
      .limit(1);
    if (!row) return PARENT_NOT_FOUND;
    if (row.projectId !== input.projectId) return PARENT_NOT_FOUND;
    currentId = row.parentId;
  }
  if ((await childCount(db, input.parentId)) >= MAX_CHILDREN_PER_CARD) return PARENT_FULL;
  return null;
}

/** How many cards were spawned from this one. */
export async function childCount(db: Pick<Db, "select">, featureId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(features)
    .where(eq(features.parentId, featureId));
  return row?.count ?? 0;
}

/** One card as the related view and the drawer draw it. */
export interface RelatedCard {
  id: string;
  title: string;
  status: string;
  currentStageId: string | null;
  stageName: string | null;
  /** The newest run's status, or null for a card no agent has worked. */
  runStatus: string | null;
  /** Summed reported cost, null when no run reported one. */
  costUsd: number | null;
  prNumber: number | null;
  prUrl: string | null;
}

/**
 * The group one card belongs to: the card that spawned things, and
 * everything it spawned.
 *
 * Resolved from the parent whichever end you open it from, so a child
 * and its parent answer with the same group. A card that has itself
 * spawned parts is the root of *its* group even when it also has a
 * parent: walking up would hide the parts the badge is counting, and
 * the first-version view is one level, not the whole chain.
 *
 * Read from the rows rather than from whatever the caller's board
 * happens to hold, which is what keeps a finished child, or one that
 * was dragged into another lane, in the picture.
 *
 * Null when this card is neither a parent nor a child: there is no
 * group, which the console reads as "draw nothing".
 */
export async function relatedGroup(
  db: Db,
  feature: { id: string; parentId: string | null },
): Promise<{ parent: RelatedCard; children: RelatedCard[]; partOf: RelatedCard | null } | null> {
  const spawned = await childCount(db, feature.id);
  const rootId = spawned > 0 ? feature.id : (feature.parentId ?? feature.id);
  // When this card is itself a parent, its own parent is not in the
  // group — it is the way back. Pulled in the same read so the drawer
  // can name it without a second round trip.
  const ancestorId = spawned > 0 ? feature.parentId : null;
  const rows = await db
    .select({ feature: features, stageName: stages.name })
    .from(features)
    .leftJoin(stages, eq(stages.id, features.currentStageId))
    .where(
      or(
        eq(features.id, rootId),
        eq(features.parentId, rootId),
        ...(ancestorId ? [eq(features.id, ancestorId)] : []),
      ),
    )
    // Creation order, which is the order the agent decided the parts
    // in. Anything else would reshuffle the view between visits.
    .orderBy(asc(features.createdAt));
  const parentRow = rows.find((r) => r.feature.id === rootId);
  const childRows = rows.filter((r) => r.feature.parentId === rootId);
  // The card is a child whose parent has since been deleted, or a
  // parent nobody spawned from. Neither is a group worth drawing.
  if (!parentRow || childRows.length === 0) return null;

  const ids = rows.map((r) => r.feature.id);
  const [runRows, prRows] = await Promise.all([
    db
      .select({
        featureId: agentRuns.featureId,
        status: agentRuns.status,
        costUsd: agentRuns.costUsd,
        queuedAt: agentRuns.queuedAt,
      })
      .from(agentRuns)
      .where(inArray(agentRuns.featureId, ids))
      .orderBy(desc(agentRuns.queuedAt)),
    db
      .select()
      .from(featurePullRequests)
      .where(inArray(featurePullRequests.featureId, ids))
      .orderBy(asc(featurePullRequests.createdAt)),
  ]);

  // By the number the card mirrors: a card that has published from
  // more than one branch has a row per branch, and the oldest of them
  // is not the pull request the card is showing. First match wins,
  // because two repositories can hold the same number; the oldest row
  // stays the fallback for a number no row carries.
  const prByNumber = new Map<string, string>();
  const oldestPr = new Map<string, string>();
  for (const pr of prRows) {
    const owner = rows.find((r) => r.feature.id === pr.featureId);
    if (!owner) continue;
    if (!oldestPr.has(pr.featureId)) oldestPr.set(pr.featureId, pr.url);
    if (owner.feature.prNumber === pr.number && !prByNumber.has(pr.featureId)) {
      prByNumber.set(pr.featureId, pr.url);
    }
  }
  const prByFeature = new Map([...oldestPr, ...prByNumber]);

  const draw = (row: (typeof rows)[number]): RelatedCard => {
    const runs = runRows.filter((r) => r.featureId === row.feature.id);
    const reported = runs.filter((r) => r.costUsd !== null);
    return {
      id: row.feature.id,
      title: row.feature.title,
      status: row.feature.status,
      currentStageId: row.feature.currentStageId,
      stageName: row.stageName ?? null,
      // Newest first from the query above, so the head is the latest.
      runStatus: runs[0]?.status ?? null,
      costUsd: reported.length > 0 ? reported.reduce((sum, r) => sum + Number(r.costUsd), 0) : null,
      prNumber: row.feature.prNumber,
      prUrl: prByFeature.get(row.feature.id) ?? null,
    };
  };

  const ancestorRow = ancestorId ? rows.find((r) => r.feature.id === ancestorId) : undefined;
  return {
    parent: draw(parentRow),
    children: childRows.map(draw),
    partOf: ancestorRow ? draw(ancestorRow) : null,
  };
}

/**
 * The children of one card, as the agent that spawned them sees them.
 *
 * Deliberately smaller than the console's view: a run needs to know
 * what it has already created so a re-queue does not file the same
 * part twice, not what any of it cost.
 */
export async function childCardsFor(
  db: Db,
  parentId: string,
): Promise<{ id: string; title: string; status: string; stage: string | null; agentWorking: boolean }[]> {
  const rows = await db
    .select({ feature: features, stageName: stages.name })
    .from(features)
    .leftJoin(stages, eq(stages.id, features.currentStageId))
    .where(eq(features.parentId, parentId))
    .orderBy(asc(features.createdAt));
  if (rows.length === 0) return [];
  const active = await db
    .select({ featureId: agentRuns.featureId })
    .from(agentRuns)
    .where(
      and(
        inArray(
          agentRuns.featureId,
          rows.map((r) => r.feature.id),
        ),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  const working = new Set(active.map((r) => r.featureId));
  return rows.map((r) => ({
    id: r.feature.id,
    title: r.feature.title,
    status: r.feature.status,
    stage: r.stageName ?? null,
    agentWorking: working.has(r.feature.id),
  }));
}
