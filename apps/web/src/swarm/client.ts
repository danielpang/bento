import { buildSwarmModel } from "./layout.js";
import { SWARM_TEMPLATES, draftSwarm, seedSwarms, summarise } from "./fixtures.js";
import type {
  NewSwarmInput,
  Swarm,
  SwarmDetail,
  SwarmPullRequest,
  SwarmStatus,
  SwarmSummary,
  SwarmTask,
  SwarmTemplate,
  TaskAttention,
} from "./types.js";

/**
 * The one place the console talks to the swarm endpoints.
 *
 * These are the routes the server actually serves, and this file is
 * held to them:
 *
 *   GET    /api/swarms?projectId=
 *   POST   /api/swarms
 *   GET    /api/swarms/:id
 *   PATCH  /api/swarms/:id
 *   POST   /api/swarms/:id/start | /pause | /cancel
 *   POST   /api/swarms/:id/messages
 *   GET    /api/swarm-templates
 *
 * Anything the console could once do that has no route behind it is
 * not in this interface. A method that quietly resolved would be a
 * button that looks like it worked, which is worse than a control that
 * says it is not available yet.
 *
 * The server answers with its rows, and the console's vocabulary is
 * close to but not the same as the table's, so the mapping happens
 * here rather than in the components: one translation, in the file
 * that owns the boundary.
 */
export interface SwarmApi {
  listSwarms(projectId: string): Promise<SwarmSummary[]>;
  getSwarm(swarmId: string): Promise<SwarmDetail>;
  listTemplates(): Promise<SwarmTemplate[]>;
  createSwarm(input: NewSwarmInput): Promise<SwarmDetail>;
  pauseSwarm(swarmId: string): Promise<void>;
  /** Resuming is starting: one route decides when a swarm may run. */
  resumeSwarm(swarmId: string): Promise<void>;
  stopSwarm(swarmId: string): Promise<void>;
  archiveSwarm(swarmId: string): Promise<void>;
  restoreSwarm(swarmId: string): Promise<void>;
  setWorkers(swarmId: string, workers: number): Promise<void>;
  /** An answer to the planner is a message to the planner. */
  answerQuestion(swarmId: string, questionId: string, text: string): Promise<void>;
}

/**
 * The fixtures answer more than the routes do, and only the tests use
 * the extra: a fixture that can mark a leaf done is how the rollup is
 * exercised without a swarm actually running one.
 */
export interface FixtureSwarmApi extends SwarmApi {
  createPullRequest(swarmId: string): Promise<SwarmPullRequest>;
  markTaskDone(swarmId: string, taskId: string): Promise<void>;
}

/**
 * The fixtures, behind the same interface.
 *
 * Mutations are kept in memory so the console behaves like a console:
 * pausing a swarm pauses it, creating one puts it at the end of the
 * strip, and marking a leaf done moves every ring above it. Nothing
 * here survives a reload, which is the honest amount of persistence
 * for a fixture. It answers the tests; the console is wired to the
 * server at the bottom of this file.
 */
export function fixtureSwarmApi(clock: () => number = () => Date.now()): FixtureSwarmApi {
  const byProject = new Map<string, SwarmDetail[]>();

  function projectSwarms(projectId: string): SwarmDetail[] {
    const held = byProject.get(projectId);
    if (held) return held;
    const seeded = seedSwarms(projectId, clock());
    byProject.set(projectId, seeded);
    return seeded;
  }

  function find(swarmId: string): SwarmDetail | null {
    for (const details of byProject.values()) {
      const found = details.find((detail) => detail.swarm.id === swarmId);
      if (found) return found;
    }
    return null;
  }

  function mutate(swarmId: string, change: (detail: SwarmDetail) => void): Promise<void> {
    const detail = find(swarmId);
    if (detail) change(detail);
    return Promise.resolve();
  }

  return {
    listSwarms(projectId) {
      return Promise.resolve(
        projectSwarms(projectId).map((detail) =>
          // The same rollup the page draws, so a tab's ring and its
          // header's ring are one number computed one way.
          summarise(detail, buildSwarmModel(detail.tasks, { now: clock() }).root.completion),
        ),
      );
    },
    getSwarm(swarmId) {
      const detail = find(swarmId);
      if (!detail) return Promise.reject(new Error("not found"));
      detail.swarm.lastOpenedAt = new Date(clock()).toISOString();
      return Promise.resolve(detail);
    },
    listTemplates() {
      return Promise.resolve(SWARM_TEMPLATES);
    },
    createSwarm(input) {
      const created = draftSwarm(input, clock());
      projectSwarms(input.projectId).push(created);
      return Promise.resolve(created);
    },
    pauseSwarm(swarmId) {
      return mutate(swarmId, (detail) => {
        detail.swarm.status = "paused";
        detail.swarm.pausedReason = "manual";
      });
    },
    resumeSwarm(swarmId) {
      return mutate(swarmId, (detail) => {
        detail.swarm.status = "running";
        detail.swarm.pausedReason = null;
      });
    },
    stopSwarm(swarmId) {
      return mutate(swarmId, (detail) => {
        detail.swarm.status = "stopped";
        detail.swarm.endedAt = new Date(clock()).toISOString();
      });
    },
    archiveSwarm(swarmId) {
      return mutate(swarmId, (detail) => {
        detail.swarm.archivedAt = new Date(clock()).toISOString();
      });
    },
    restoreSwarm(swarmId) {
      return mutate(swarmId, (detail) => {
        detail.swarm.archivedAt = null;
      });
    },
    setWorkers(swarmId, workers) {
      return mutate(swarmId, (detail) => {
        detail.swarm.workers = Math.max(1, Math.min(detail.swarm.maxWorkers, Math.round(workers)));
      });
    },
    answerQuestion(swarmId, questionId, text) {
      return mutate(swarmId, (detail) => {
        if (detail.swarm.question?.id !== questionId) return;
        detail.swarm.question = null;
        detail.swarm.status = "running";
        // The answer goes to the planner. Nothing renders it back,
        // because the transcript is where an answer belongs.
        void text;
      });
    },
    createPullRequest(swarmId) {
      const detail = find(swarmId);
      const pr: SwarmPullRequest = {
        id: `pr-${swarmId}`,
        repoUrl: "github.com/acme/storefront",
        number: 4200 + (detail?.pullRequests.length ?? 0),
        url: "https://github.com/acme/storefront/pull/4200",
        headSha: null,
      };
      if (detail) detail.pullRequests = [...detail.pullRequests, pr];
      return Promise.resolve(pr);
    },
    markTaskDone(swarmId, taskId) {
      return mutate(swarmId, (detail) => {
        detail.tasks = detail.tasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "done", attention: "none", endedAt: new Date(clock()).toISOString() }
            : task,
        );
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * The rows the server sends, and what the console calls them.
 * ------------------------------------------------------------------ */

/** The most workers the create and update routes accept. */
export const WORKER_CEILING = 32;

/** A swarm row, as JSON. Numerics arrive as strings; timestamps as ISO. */
export interface WireSwarm {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  goal: string;
  status: string;
  pausedReason: Swarm["pausedReason"];
  branchName: string | null;
  templateId: string | null;
  budgetUsd: string | null;
  maxWorkers: number;
  timeLimitMin: number | null;
  spentMeasuredUsd: string;
  spentEstimatedUsd: string;
  spentAssumedUsd: string;
  archivedAt: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
}

export interface WireSwarmRow extends WireSwarm {
  counts: { tasks: number; done: number; attention: number };
}

export interface WireTask {
  id: string;
  parentId: string | null;
  position: number;
  title: string;
  description: string;
  nodeType: "plan" | "leaf";
  status: SwarmTask["status"];
  attention: string | null;
  weight: number;
  assignedRunId: string | null;
  branchName: string | null;
  flags: Record<string, unknown>;
  report: string | null;
  costMeasuredUsd: string;
  costEstimatedUsd: string;
  costAssumedUsd: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface WireDetail {
  swarm: WireSwarm;
  tasks: WireTask[];
  activeRuns: { id: string; role: string | null; status: string; swarmTaskId: string | null }[];
}

export interface WireTemplate {
  id: string;
  name: string;
  description: string;
  maxWorkers: number;
  budgetUsd: string | null;
  timeLimitMin: number | null;
}

const number = (value: string | null): number => (value === null ? 0 : Number(value));

/**
 * A swarm's status, in the words the console draws.
 *
 * Two rows differ. A swarm the server calls blocked is one waiting for
 * a person, which is what "waiting" means here; a cancelled one is
 * stopped. A swarm paused because it ran out of budget says so, which
 * is a different sentence and a different button from a swarm somebody
 * paused by hand.
 */
export function swarmStatusOf(row: { status: string; pausedReason: Swarm["pausedReason"] }): SwarmStatus {
  if (row.status === "paused") return row.pausedReason === "budget" ? "budget_exhausted" : "paused";
  switch (row.status) {
    case "blocked":
      return "waiting";
    case "cancelled":
      return "stopped";
    // A swarm is created planning, so draft is a row nothing writes
    // today. It reads as planning rather than as a sixth word.
    case "draft":
      return "planning";
    case "planning":
    case "running":
    case "done":
    case "failed":
      return row.status;
    default:
      return "planning";
  }
}

/**
 * A leaf's attention, in the two severities the console draws.
 *
 * The server records why as well as how loudly (a question, a
 * conflict, a failure, a budget stop). The console paints one yellow,
 * so every reason that wants a person now reads as escalated.
 */
export function attentionOf(attention: string | null): TaskAttention {
  if (attention === null) return "none";
  if (attention === "long_running") return "long_running";
  return "escalated";
}

/** One row of the plan, as the tree and the outline read it. */
export function toTask(row: WireTask): SwarmTask {
  return {
    id: row.id,
    parentId: row.parentId,
    position: row.position,
    title: row.title,
    description: row.description,
    nodeType: row.nodeType,
    status: row.status,
    attention: attentionOf(row.attention),
    weight: row.weight,
    assignedRunId: row.assignedRunId,
    branchName: row.branchName,
    cost: {
      measuredUsd: number(row.costMeasuredUsd),
      estimatedUsd: number(row.costEstimatedUsd),
      assumedUsd: number(row.costAssumedUsd),
    },
    flags: row.flags,
    report: row.report,
    // The plan carries no acceptance criteria and no per leaf commit
    // list yet. Empty rather than invented: the drawer already says so
    // in words when there is nothing to show.
    acceptanceCriteria: [],
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    commits: [],
  };
}

/**
 * The swarm itself.
 *
 * `workers` is this swarm's own ceiling, which is the number the
 * stepper changes; `maxWorkers` is as high as the route will let it
 * go. `workersActive` is counted from the runs the detail route sends,
 * so a summary row (which carries none) reads as none working.
 */
export function toSwarm(row: WireSwarm, workersActive = 0): Swarm {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.title,
    slug: row.slug,
    goal: row.goal,
    status: swarmStatusOf(row),
    pausedReason: row.pausedReason,
    branchName: row.branchName,
    // Every swarm on this branch produces code. Nothing on the server
    // records a second kind yet.
    deliverable: "code",
    templateId: row.templateId,
    budgetUsd: row.budgetUsd === null ? null : Number(row.budgetUsd),
    maxWorkers: WORKER_CEILING,
    workers: row.maxWorkers,
    workersActive,
    timeLimitMin: row.timeLimitMin,
    spend: {
      measuredUsd: number(row.spentMeasuredUsd),
      estimatedUsd: number(row.spentEstimatedUsd),
      assumedUsd: number(row.spentAssumedUsd),
    },
    // The rows carry when a swarm was made and when it was put away,
    // not when its first agent started or its last one stopped. The
    // header falls back to the creation time for the elapsed clock.
    startedAt: null,
    endedAt: null,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    lastOpenedAt: row.lastOpenedAt,
    // A planner's question reaches the board as attention on the node
    // that asked it. There is no question row to answer yet.
    question: null,
  };
}

/** A strip row. Its ring is the server's count of finished tasks. */
export function toSummary(row: WireSwarmRow): SwarmSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.title,
    status: swarmStatusOf(row),
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    lastOpenedAt: row.lastOpenedAt,
    completion: row.counts.tasks === 0 ? 0 : row.counts.done / row.counts.tasks,
  };
}

/**
 * A template, with the ceilings it sets.
 *
 * The cost shape is empty: the route names the agents by id, and what
 * a tool reports its spend in is not recorded anywhere yet. The dialog
 * and the templates panel draw those parts only when a template has
 * them, so an estimate is absent rather than a confident zero.
 */
export function toTemplate(row: WireTemplate): SwarmTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    plannerModel: "",
    workerModel: "",
    tools: [],
    assumedUsdPerLeaf: 0,
    perLeaf: { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0 },
    maxWorkers: row.maxWorkers,
    maxBudgetUsd: row.budgetUsd === null ? null : Number(row.budgetUsd),
    timeLimitMin: row.timeLimitMin,
    typicalLeaves: 0,
  };
}

/**
 * The console against the real routes. Same credentials and the same
 * failure shape as every other call the console makes.
 *
 * `fetch` is taken as an argument because a stored `window.fetch`
 * throws when it is called unbound, and because a test that has to
 * stand up a server to check which path a button hits is a test
 * nobody writes.
 */
export function httpSwarmApi(
  baseUrl = "",
  doFetch: typeof fetch = (input, init) => fetch(input, init),
): SwarmApi {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      credentials: "include",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      ...init,
    });
    if (!res.ok) throw new Error(errorText(await res.text()));
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
  const post = <T>(path: string, body?: unknown) =>
    call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const patch = <T>(path: string, body: unknown) =>
    call<T>(path, { method: "PATCH", body: JSON.stringify(body) });

  return {
    async listSwarms(projectId) {
      const rows = await call<WireSwarmRow[]>(`/api/swarms?projectId=${encodeURIComponent(projectId)}`);
      return rows.map(toSummary);
    },
    async getSwarm(swarmId) {
      const detail = await call<WireDetail>(`/api/swarms/${swarmId}`);
      return toDetail(detail);
    },
    async listTemplates() {
      return (await call<WireTemplate[]>("/api/swarm-templates")).map(toTemplate);
    },
    async createSwarm(input) {
      /*
       * What the route takes, and nothing else. The dialog collects a
       * few things the server has no home for yet (attachments, a
       * starting branch, the deliverable, plan only); they are not
       * sent, because a field the server drops is a promise the
       * console did not keep.
       */
      const created = await post<WireSwarm>("/api/swarms", {
        projectId: input.projectId,
        title: input.name,
        goal: input.goal,
        ...(input.templateId ? { templateId: input.templateId } : {}),
        maxWorkers: input.workers,
        ...(input.budgetUsd === null ? {} : { budgetUsd: input.budgetUsd }),
      });
      return { swarm: toSwarm(created), tasks: [], landings: [], ledger: [], pullRequests: [] };
    },
    async pauseSwarm(swarmId) {
      await post(`/api/swarms/${swarmId}/pause`);
    },
    async resumeSwarm(swarmId) {
      await post(`/api/swarms/${swarmId}/start`);
    },
    async stopSwarm(swarmId) {
      await post(`/api/swarms/${swarmId}/cancel`);
    },
    async archiveSwarm(swarmId) {
      await patch(`/api/swarms/${swarmId}`, { archived: true });
    },
    async restoreSwarm(swarmId) {
      await patch(`/api/swarms/${swarmId}`, { archived: false });
    },
    async setWorkers(swarmId, workers) {
      await patch(`/api/swarms/${swarmId}`, { maxWorkers: workers });
    },
    async answerQuestion(swarmId, questionId, text) {
      // The planner hears everything as a message, and the coordinator
      // folds what is waiting into its next turn. Which question is
      // being answered is not a thing the server tracks.
      void questionId;
      await post(`/api/swarms/${swarmId}/messages`, { text });
    },
  };
}

/** One swarm and its plan, as the page reads it. */
export function toDetail(detail: WireDetail): SwarmDetail {
  const working = detail.activeRuns.filter((run) => run.role === "worker").length;
  return {
    swarm: toSwarm(detail.swarm, working),
    tasks: detail.tasks.map(toTask),
    // The merge queue, the ledger and this swarm's pull requests are
    // not served yet. Empty, so nothing is drawn rather than drawn
    // wrong; the surfaces that read them render only when they hold
    // something.
    landings: [],
    ledger: [],
    pullRequests: [],
  };
}

/**
 * What went wrong, in the server's own words when it sent any.
 *
 * The routes answer errors as JSON, so a raw body would put braces and
 * quotes in front of a person.
 */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") return parsed.error;
  } catch {
    // Not JSON. The body is the best there is.
  }
  return body || "something went wrong";
}

/**
 * What the console uses: the server, through the routes above.
 */
export const swarmApi: SwarmApi = httpSwarmApi();
