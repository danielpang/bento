import { buildSwarmModel } from "./layout.js";
import { SWARM_TEMPLATES, draftSwarm, seedSwarms, summarise } from "./fixtures.js";
import type {
  NewSwarmInput,
  SwarmDetail,
  SwarmPullRequest,
  SwarmSummary,
  SwarmTemplate,
} from "./types.js";

/**
 * The one place the console talks to the swarm endpoints.
 *
 * The endpoints do not exist yet, so `fixtureSwarmApi` answers and
 * the whole console is drivable today. `httpSwarmApi` is what the
 * routes will be reached through, written now so the shapes are
 * agreed and switching over is a single line at the bottom of this
 * file rather than a change in every component.
 *
 *   GET   /api/projects/:id/swarms
 *   GET   /api/swarms/:id
 *   POST  /api/swarms
 *   POST  /api/swarms/:id/pause | /resume | /stop | /archive | /restore
 *   PATCH /api/swarms/:id            { workers }
 *   POST  /api/swarms/:id/answer     { questionId, text }
 *   POST  /api/swarms/:id/pull-request
 *   POST  /api/swarms/:id/tasks/:taskId/done
 *   GET   /api/swarm-templates
 *
 * Every one of those is an entity route, so each will resolve the
 * swarm through an access helper and answer 404 when it is not this
 * tenant's, and each belongs in the matrix test that says so.
 */
export interface SwarmApi {
  listSwarms(projectId: string): Promise<SwarmSummary[]>;
  getSwarm(swarmId: string): Promise<SwarmDetail>;
  listTemplates(): Promise<SwarmTemplate[]>;
  createSwarm(input: NewSwarmInput): Promise<SwarmDetail>;
  pauseSwarm(swarmId: string): Promise<void>;
  resumeSwarm(swarmId: string): Promise<void>;
  stopSwarm(swarmId: string): Promise<void>;
  archiveSwarm(swarmId: string): Promise<void>;
  restoreSwarm(swarmId: string): Promise<void>;
  setWorkers(swarmId: string, workers: number): Promise<void>;
  answerQuestion(swarmId: string, questionId: string, text: string): Promise<void>;
  createPullRequest(swarmId: string): Promise<SwarmPullRequest>;
  /**
   * Phase one has no workers, so a leaf is finished by hand from the
   * drawer. The route stays after they arrive: somebody has to be
   * able to say a leaf is done that an agent could not finish.
   */
  markTaskDone(swarmId: string, taskId: string): Promise<void>;
}

/**
 * The fixtures, behind the same interface.
 *
 * Mutations are kept in memory so the console behaves like a console:
 * pausing a swarm pauses it, creating one puts it at the end of the
 * strip, and marking a leaf done moves every ring above it. Nothing
 * here survives a reload, which is the honest amount of persistence
 * for a fixture.
 */
export function fixtureSwarmApi(clock: () => number = () => Date.now()): SwarmApi {
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

/**
 * The real thing, for when the routes land. Same credentials and the
 * same failure shape as every other call the console makes.
 */
export function httpSwarmApi(baseUrl = ""): SwarmApi {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      credentials: "include",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      ...init,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
  const post = (path: string, body?: unknown) =>
    call<void>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    listSwarms: (projectId) => call<SwarmSummary[]>(`/api/projects/${projectId}/swarms`),
    getSwarm: (swarmId) => call<SwarmDetail>(`/api/swarms/${swarmId}`),
    listTemplates: () => call<SwarmTemplate[]>("/api/swarm-templates"),
    createSwarm: (input) =>
      call<SwarmDetail>("/api/swarms", { method: "POST", body: JSON.stringify(input) }),
    pauseSwarm: (swarmId) => post(`/api/swarms/${swarmId}/pause`),
    resumeSwarm: (swarmId) => post(`/api/swarms/${swarmId}/resume`),
    stopSwarm: (swarmId) => post(`/api/swarms/${swarmId}/stop`),
    archiveSwarm: (swarmId) => post(`/api/swarms/${swarmId}/archive`),
    restoreSwarm: (swarmId) => post(`/api/swarms/${swarmId}/restore`),
    setWorkers: (swarmId, workers) =>
      call<void>(`/api/swarms/${swarmId}`, { method: "PATCH", body: JSON.stringify({ workers }) }),
    answerQuestion: (swarmId, questionId, text) =>
      post(`/api/swarms/${swarmId}/answer`, { questionId, text }),
    createPullRequest: (swarmId) =>
      call<SwarmPullRequest>(`/api/swarms/${swarmId}/pull-request`, { method: "POST" }),
    markTaskDone: (swarmId, taskId) => post(`/api/swarms/${swarmId}/tasks/${taskId}/done`),
  };
}

/**
 * What the console uses. One line to change when the routes land, and
 * `httpSwarmApi` is already the thing to change it to.
 */
export const swarmApi: SwarmApi = fixtureSwarmApi();
