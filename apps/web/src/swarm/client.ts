import { MAX_SWARM_WORKERS } from "@bento/core";
import { externalHttpUrl } from "../external-url.js";
import { buildSwarmModel } from "./layout.js";
import { SWARM_TEMPLATES, draftSwarm, seedSwarms, summarise } from "./fixtures.js";
import type {
  NewSwarmInput,
  Swarm,
  SwarmArtifact,
  SwarmDetail,
  SwarmLanding,
  SwarmNodeDetail,
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
  createTemplate(input: TemplateInput): Promise<SwarmTemplate>;
  /**
   * Every field optional, so renaming a template does not restate its
   * ceilings. Null clears a budget or a time limit.
   */
  updateTemplate(templateId: string, input: Partial<TemplateInput>): Promise<SwarmTemplate>;
  deleteTemplate(templateId: string): Promise<void>;
  /**
   * This swarm's shape, kept for the next one.
   *
   * The server does the copying: it has the template the swarm came
   * from, and the console has no business inventing the fields a swarm
   * does not carry.
   */
  saveSwarmAsTemplate(swarmId: string, name: string): Promise<SwarmTemplate>;
  /**
   * The agents a leaf can be handed to.
   *
   * The same list the card board's agent picker draws, read here
   * because reassigning a node is choosing from it. Names only: what
   * the drawer needs is something to put in a menu.
   */
  listAgents(): Promise<{ id: string; name: string }[]>;
  createSwarm(input: NewSwarmInput): Promise<SwarmDetail>;
  pauseSwarm(swarmId: string): Promise<void>;
  /** Resuming is starting: one route decides when a swarm may run. */
  resumeSwarm(swarmId: string): Promise<void>;
  stopSwarm(swarmId: string): Promise<void>;
  /**
   * Takes a finished swarm up again with a follow up.
   *
   * Not a resume. Resuming is a swarm that was paused; this is one
   * that finished and published, being asked for more on the same
   * branch, so the pull requests it already opened are updated rather
   * than joined by a second set. The raised ceilings travel with the
   * instruction because a swarm that stopped on one would otherwise be
   * reopened into stopping on it again.
   */
  reopenSwarm(
    swarmId: string,
    input: { instruction: string; budgetUsd?: number | null; timeLimitMin?: number | null },
  ): Promise<void>;
  archiveSwarm(swarmId: string): Promise<void>;
  restoreSwarm(swarmId: string): Promise<void>;
  setWorkers(swarmId: string, workers: number): Promise<void>;
  /** An answer to the planner is a message to the planner. */
  answerQuestion(swarmId: string, questionId: string, text: string): Promise<void>;
  /**
   * Finishes a leaf because a person says it is finished.
   *
   * The tree is an agent's to fill in and a person's to correct, so
   * this is not a fixture convenience: a leaf nobody is going to work,
   * or one somebody already did by hand, is done, and the rollup above
   * it should say so.
   */
  markTaskDone(swarmId: string, taskId: string): Promise<void>;
  /**
   * The node controls a person steers a swarm with.
   *
   * Retry puts a leaf back in the queue with the attempt that failed
   * cleared off it; the reconciler decides when there is room for it,
   * which is why nothing here starts an agent directly. Cancel takes
   * the subtree and stops whatever is on it. Split turns a leaf into
   * the tasks it should have been. Reassign writes a different agent
   * on this leaf alone, and null puts it back on the template's own.
   * Edit is what makes a retry worth doing, since a task that failed
   * for saying the wrong thing fails again against the same words.
   */
  retryTask(swarmId: string, taskId: string): Promise<void>;
  cancelTask(swarmId: string, taskId: string): Promise<void>;
  splitTask(swarmId: string, taskId: string, children: { title: string; description?: string }[]): Promise<void>;
  /**
   * Adds a task to the plan under one of its plan nodes.
   *
   * The other half of a tree a person and an agent share. It goes in
   * ready to be worked, and the planner is told and may object.
   */
  addTask(swarmId: string, parentId: string, task: { title: string; description?: string }): Promise<void>;
  reassignTask(swarmId: string, taskId: string, agentProfileId: string | null): Promise<void>;
  editTask(
    swarmId: string,
    taskId: string,
    edit: { title?: string; description?: string; weight?: number },
  ): Promise<void>;
  /**
   * One node's commits and its history, asked for when it is opened.
   *
   * Not part of the plan the page already holds, because reading the
   * commits means grepping a branch per repository for the node's
   * trailer: a plan of two hundred nodes would pay for that on every
   * refetch, for a list nobody looks at until a drawer is open.
   */
  getNode(swarmId: string, taskId: string): Promise<SwarmNodeDetail>;
  /**
   * What the swarm produced for people to read.
   *
   * Its own request rather than part of the detail, for the reason the
   * node's commits are: it is a panel a person opens once a swarm has
   * finished, and the plan is refetched on every board event.
   */
  listArtifacts(swarmId: string): Promise<SwarmArtifact[]>;
  /**
   * Sends a message to the agent working one node.
   *
   * The same door the planner's messages go through, with the node
   * named. Queued rather than delivered: a headless agent cannot hear
   * mid turn, so the coordinator folds what is waiting into the next
   * one. The composer says so rather than implying it arrived.
   */
  messageTask(swarmId: string, taskId: string, text: string): Promise<void>;
  /**
   * The swarm's own event stream, for as long as one is open.
   *
   * A swarm is watched rather than read: the planner writes the tree
   * over minutes and the reconciler rolls finishes up afterwards, so a
   * page that only fetched on click shows a board that was true when
   * you clicked. Scoped to one swarm server side, so a busy card board
   * on the same project does not wake this page.
   *
   * onReconnect fires when the stream comes back after a drop. Board
   * events are not persisted, so whatever fired meanwhile is gone and
   * the caller's answer is to refetch rather than to wait.
   *
   * Returns the unsubscribe.
   */
  streamSwarm(swarmId: string, onEvent: () => void, onReconnect?: () => void): () => void;
}

/**
 * The fixtures answer more than the routes do, and only the tests use
 * the extra: opening a pull request is the merge queue's, and until
 * the merge queue exists a fixture is the only thing that can put a
 * row on the header.
 */
export interface FixtureSwarmApi extends SwarmApi {
  createPullRequest(swarmId: string): Promise<SwarmPullRequest>;
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

  /*
   * A copy, because the fixture client now writes to it. The exported
   * constant is shared by every test in the file, and a create in one
   * that leaked into the next would make the order they run in matter.
   */
  const templates: SwarmTemplate[] = SWARM_TEMPLATES.map((row) => ({ ...row }));

  /*
   * Ids come from a counter rather than the list's length, which
   * collides the moment anything is deleted: three rows, two creates,
   * one delete, and the next create repeats an id that is still in the
   * list. Two rows sharing an id is a duplicate React key, and every
   * edit and delete here finds by id, so the second row's changes land
   * on the first.
   */
  let nextTemplateId = templates.length;

  /** A template row from the fields the panel edits, over a base row. */
  function fixtureTemplate(
    base: SwarmTemplate,
    input: Partial<TemplateInput>,
    id: string,
  ): SwarmTemplate {
    return {
      ...base,
      id,
      name: input.name ?? base.name,
      description: input.description ?? base.description,
      maxWorkers: input.maxWorkers ?? base.maxWorkers,
      workerIsolation: input.workerIsolation ?? base.workerIsolation,
      maxBudgetUsd: input.budgetUsd !== undefined ? input.budgetUsd : base.maxBudgetUsd,
      timeLimitMin: input.timeLimitMin !== undefined ? input.timeLimitMin : base.timeLimitMin,
    };
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
      // Copies, so a caller holding the result cannot write through it
      // into the fixture's own state.
      return Promise.resolve(templates.map((row) => ({ ...row })));
    },
    createTemplate(input) {
      nextTemplateId += 1;
      // A new template is its own row, not a variant of the first
      // fixture: only the cost shape, which the panel does not edit,
      // has anywhere else to come from.
      const created = fixtureTemplate(
        { ...SWARM_TEMPLATES[0]!, maxBudgetUsd: null, timeLimitMin: null },
        input,
        `template-${nextTemplateId}`,
      );
      templates.push(created);
      return Promise.resolve({ ...created });
    },
    updateTemplate(templateId, input) {
      const at = templates.findIndex((row) => row.id === templateId);
      if (at < 0) return Promise.reject(new Error("not found"));
      const updated = fixtureTemplate(templates[at]!, input, templateId);
      templates[at] = updated;
      return Promise.resolve({ ...updated });
    },
    deleteTemplate(templateId) {
      const at = templates.findIndex((row) => row.id === templateId);
      if (at >= 0) templates.splice(at, 1);
      return Promise.resolve();
    },
    saveSwarmAsTemplate(swarmId, name) {
      const detail = find(swarmId);
      if (!detail) return Promise.reject(new Error("not found"));
      // The fixture's version of what the route does: the swarm's own
      // ceilings over the template it was made with.
      const source = templates.find((row) => row.id === detail.swarm.templateId) ?? templates[0]!;
      nextTemplateId += 1;
      const created: SwarmTemplate = {
        ...source,
        id: `template-${nextTemplateId}`,
        name,
        description: `Saved from the swarm "${detail.swarm.name}".`,
        maxWorkers: detail.swarm.workers,
        maxBudgetUsd: detail.swarm.budgetUsd,
        timeLimitMin: detail.swarm.timeLimitMin,
      };
      templates.push(created);
      return Promise.resolve({ ...created });
    },
    listAgents() {
      return Promise.resolve([
        { id: "agent-planner", name: "Planner" },
        { id: "agent-worker", name: "Worker" },
      ]);
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
    reopenSwarm(swarmId, input) {
      return mutate(swarmId, (detail) => {
        const followUp = detail.swarm.reopenCount + 1;
        detail.swarm.status = "running";
        detail.swarm.pausedReason = null;
        detail.swarm.endedAt = null;
        detail.swarm.archivedAt = null;
        detail.swarm.reopenCount = followUp;
        if (input.budgetUsd !== undefined) detail.swarm.budgetUsd = input.budgetUsd;
        if (input.timeLimitMin !== undefined) detail.swarm.timeLimitMin = input.timeLimitMin;
        const first = detail.tasks[0];
        if (!first) return;
        // A plan node at the top of the tree, the way the server makes
        // one: the fixtures are how the console is driven in tests, so
        // what they model has to be the shape the routes produce.
        detail.tasks = [
          ...detail.tasks,
          {
            ...first,
            id: `${detail.swarm.id}-follow-up-${followUp}`,
            parentId: null,
            position: detail.tasks.filter((task) => task.parentId === null).length,
            nodeType: "plan",
            status: "open",
            attention: "none",
            title: `Follow up ${followUp}`,
            description: input.instruction,
            followUpInstruction: input.instruction,
            report: null,
            commits: [],
          },
        ];
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
    listArtifacts(swarmId) {
      // The fixtures capture nothing, so there is nothing to list.
      // Empty rather than invented: the panel draws only when a swarm
      // actually produced something.
      void swarmId;
      return Promise.resolve([]);
    },
    getNode(swarmId, taskId) {
      const detail = find(swarmId);
      const task = detail?.tasks.find((row) => row.id === taskId);
      // The fixtures carry commits on the task itself, which is where
      // they lived before the node route existed. No events: nothing
      // in the fixtures writes one.
      return Promise.resolve({ taskId, commits: task?.commits ?? [], events: [] });
    },
    messageTask(swarmId, taskId, text) {
      void swarmId;
      void taskId;
      void text;
      return Promise.resolve();
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
    /*
     * The node controls, kept in memory so the console behaves like a
     * console: retrying a failed leaf really does put it back in the
     * queue, and cancelling one really does grey it out. What the
     * server does with the subtree and the agents is the server's; a
     * fixture that tried to reproduce it would be a second set of
     * rules to keep in step.
     */
    retryTask(swarmId, taskId) {
      return mutate(swarmId, (detail) => {
        detail.tasks = detail.tasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "assigned", attention: "none", report: null, endedAt: null }
            : task,
        );
      });
    },
    cancelTask(swarmId, taskId) {
      return mutate(swarmId, (detail) => {
        const doomed = new Set<string>([taskId]);
        // The subtree, the way the server takes it: a plan node nobody
        // needs has no children anybody needs.
        for (let pass = 0; pass < 64; pass += 1) {
          const before = doomed.size;
          for (const task of detail.tasks) {
            if (task.parentId && doomed.has(task.parentId)) doomed.add(task.id);
          }
          if (doomed.size === before) break;
        }
        detail.tasks = detail.tasks.map((task) =>
          doomed.has(task.id)
            ? { ...task, status: "cancelled", attention: "none", endedAt: new Date(clock()).toISOString() }
            : task,
        );
      });
    },
    splitTask(swarmId, taskId, children) {
      return mutate(swarmId, (detail) => {
        const parent = detail.tasks.find((task) => task.id === taskId);
        if (!parent) return;
        detail.tasks = [
          ...detail.tasks.map((task) =>
            task.id === taskId ? { ...task, nodeType: "plan" as const, status: "open" as const } : task,
          ),
          ...children.map((child, index) => ({
            ...parent,
            id: `${taskId}-${index + 1}`,
            parentId: taskId,
            position: index,
            nodeType: "leaf" as const,
            status: "open" as const,
            attention: "none" as const,
            title: child.title,
            description: child.description ?? "",
            report: null,
            commits: [],
          })),
        ];
      });
    },
    addTask(swarmId, parentId, task) {
      return mutate(swarmId, (detail) => {
        const parent = detail.tasks.find((row) => row.id === parentId);
        if (!parent) return;
        detail.tasks = [
          ...detail.tasks,
          {
            ...parent,
            id: `${parentId}-added-${detail.tasks.length}`,
            parentId,
            position: detail.tasks.filter((row) => row.parentId === parentId).length,
            nodeType: "leaf" as const,
            status: "assigned" as const,
            attention: "none" as const,
            title: task.title,
            description: task.description ?? "",
            report: null,
            commits: [],
          },
        ];
      });
    },
    reassignTask(swarmId, taskId, agentProfileId) {
      return mutate(swarmId, (detail) => {
        detail.tasks = detail.tasks.map((task) => (task.id === taskId ? { ...task, agentProfileId } : task));
      });
    },
    editTask(swarmId, taskId, edit) {
      return mutate(swarmId, (detail) => {
        detail.tasks = detail.tasks.map((task) => (task.id === taskId ? { ...task, ...edit } : task));
      });
    },
    // Fixtures change only when something here changes them, so there
    // is nothing to hear: the subscription is real and the stream is
    // empty, which is what a fixture should be.
    streamSwarm() {
      return () => {};
    },
  };
}

/* ------------------------------------------------------------------ *
 * The rows the server sends, and what the console calls them.
 * ------------------------------------------------------------------ */

/** The most workers the create and update routes accept. */
/**
 * The console's name for the one ceiling, re-exported rather than
 * restated. A second literal here is how the stepper came to offer a
 * number the route would refuse.
 */
export const WORKER_CEILING = MAX_SWARM_WORKERS;

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
  /**
   * Optional, because a server older than the tier does not send it.
   * Absent reads as zero, which is true there: nothing on that
   * deployment ever borrowed a login.
   */
  spentNotionalUsd?: string;
  /**
   * Optional for the reason the notional tier is: a server that
   * predates the column sends nothing, and nothing reads as the first
   * pass of a code swarm started from no branch, which is what every
   * swarm on such a server is.
   */
  deliverable?: "code" | "document";
  startBranch?: string | null;
  reopenCount?: number;
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
  agentProfileId?: string | null;
  flags: Record<string, unknown>;
  report: string | null;
  costMeasuredUsd: string;
  costEstimatedUsd: string;
  costAssumedUsd: string;
  costNotionalUsd?: string;
  /** Optional for the reason the swarm's deliverable is. */
  followUpInstruction?: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** One row of the merge queue, as the detail sends it. */
export interface WireLanding {
  id: string;
  taskId: string;
  branchName: string | null;
  position: number;
  status: "queued" | "landing" | "landed" | "conflicted" | "failed" | "cancelled";
  attempt: number;
  error: string | null;
  resolverRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface WireDetail {
  swarm: WireSwarm;
  tasks: WireTask[];
  activeRuns: { id: string; role: string | null; status: string; swarmTaskId: string | null }[];
  /**
   * Optional, because a detail from a server that predates the merge
   * queue has none and a panel that read undefined.length would take
   * the whole page down over a field that is only ever informational.
   */
  landings?: WireLanding[];
  /** Optional for the same reason the landings are. */
  pullRequests?: WirePullRequest[];
}

/** One node, as its own route sends it. */
export interface WireNode {
  commits?: { repository?: string; sha: string; subject: string; at: string }[];
  events?: {
    id: string;
    kind: string;
    at: string;
    fromStatus: string | null;
    toStatus: string | null;
    runId: string | null;
    detail: Record<string, unknown> | null;
  }[];
}

/** One pull request a finished swarm opened, as the detail sends it. */
export interface WirePullRequest {
  id: string;
  repoUrl: string;
  number: number;
  url: string;
  headSha: string | null;
}

/**
 * What the templates panel may set on a template.
 *
 * A subset of the column list on purpose: the agents, the operating
 * instructions and the judge are chosen in the Agents panel beside it
 * and carried by the swarm file, and a form that asked for all of them
 * would be the swarm file with worse errors. What is here is what a
 * person changes between one swarm and the next.
 */
export interface TemplateInput {
  name: string;
  description: string;
  maxWorkers: number;
  /** Null clears the cap, which is not the same as a cap of zero. */
  budgetUsd: number | null;
  timeLimitMin: number | null;
  /**
   * Optional, and absent is the ordinary case for a new template.
   *
   * The create route fills it from the deployment (a machine each on a
   * hosted install, worktrees on a local one), and a console that
   * always stated a value took that answer away: every template made
   * here would have said worktrees, which a hosted deployment refuses
   * at provisioning time, long after the person pressed Save.
   */
  workerIsolation?: "sandbox" | "worktree";
}

export interface WireTemplate {
  id: string;
  name: string;
  description: string;
  workerIsolation?: "sandbox" | "worktree";
  maxWorkers: number;
  budgetUsd: string | null;
  timeLimitMin: number | null;
}

/**
 * A numeric column, as JSON sends it. Absent and null both read as
 * zero: a server that predates a tier is not a server whose swarms
 * spent an unknown amount in it.
 */
const number = (value: string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

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
  if (row.status === "cancelled") return "stopped";
  if (row.status === "done") return "done";
  if (row.status === "failed") return "failed";
  /*
   * A question the swarm itself asked, which is a swarm waiting for a
   * person whatever its tree is doing.
   *
   * An agent that asks about the goal rather than about one leaf has
   * no node to hang the attention off, so it records the reason on the
   * swarm and leaves the status alone: the status is the tree's, and
   * the next tick would recompute it anyway. The reason is therefore
   * what the board has to read, and answering is what ends the wait
   * (the messages route clears it on the way in).
   */
  if (row.pausedReason === "attention") return "waiting";
  switch (row.status) {
    case "blocked":
      return "waiting";
    // A swarm is created planning, so draft is a row nothing writes
    // today. It reads as planning rather than as a sixth word.
    case "draft":
      return "planning";
    case "running":
      return "running";
    case "planning":
      return "planning";
    default:
      return "planning";
  }
}

/**
 * A leaf's attention, in the server's own words.
 *
 * Carried through rather than flattened. It was flattened once, to
 * "escalated", and the board then said the same two words about a
 * planner's question, a merge conflict, a failed worker and a swarm
 * out of money: all four true, none of them useful, and no two of them
 * answered the same way. One colour, one sentence each.
 *
 * A word this console does not know reads as escalated, which is the
 * honest fallback: something wants a person, and this build cannot say
 * what.
 */
const ATTENTION_WORDS: TaskAttention[] = [
  "long_running",
  "escalated",
  "question",
  "failed",
  "conflict",
  "budget",
  "plan_limit",
];

export function attentionOf(attention: string | null): TaskAttention {
  if (attention === null) return "none";
  const known = ATTENTION_WORDS.find((word) => word === attention);
  return known ?? "escalated";
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
    agentProfileId: row.agentProfileId ?? null,
    cost: {
      measuredUsd: number(row.costMeasuredUsd),
      estimatedUsd: number(row.costEstimatedUsd),
      assumedUsd: number(row.costAssumedUsd),
      // A server that predates the tier sends nothing, which reads as
      // zero: no run there ever borrowed a login.
      notionalUsd: number(row.costNotionalUsd),
    },
    flags: row.flags,
    report: row.report,
    // The plan carries no acceptance criteria and no per leaf commit
    // list yet. Empty rather than invented: the drawer already says so
    // in words when there is nothing to show.
    acceptanceCriteria: [],
    followUpInstruction: row.followUpInstruction ?? null,
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
    deliverable: row.deliverable ?? "code",
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
      notionalUsd: number(row.spentNotionalUsd),
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
    reopenCount: row.reopenCount ?? 0,
    startBranch: row.startBranch ?? null,
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
    perLeaf: { measuredUsd: 0, estimatedUsd: 0, assumedUsd: 0, notionalUsd: 0 },
    maxWorkers: row.maxWorkers,
    // A server that predates the column says nothing, which reads the
    // same way a template that asserts nothing does.
    workerIsolation: row.workerIsolation ?? "sandbox",
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
export interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

/**
 * A template's fields as the routes take them.
 *
 * Only what was actually given: the update route treats an absent
 * field as "leave it" and a null one as "clear it", and a body that
 * spelled out every field would turn a rename into a rewrite of the
 * ceilings the swarm running under it is using.
 */
function templateBody(input: Partial<TemplateInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.maxWorkers !== undefined) body.maxWorkers = input.maxWorkers;
  if (input.budgetUsd !== undefined) body.budgetUsd = input.budgetUsd;
  if (input.timeLimitMin !== undefined) body.timeLimitMin = input.timeLimitMin;
  if (input.workerIsolation !== undefined) body.workerIsolation = input.workerIsolation;
  return body;
}

export function httpSwarmApi(
  baseUrl = "",
  doFetch: typeof fetch = (input, init) => fetch(input, init),
  // Taken as an argument for the reason fetch is, and because Node has
  // no EventSource at all: a test that wants to know what this page
  // subscribes to should not have to stand up a server to find out.
  openStream: ((url: string) => EventSourceLike) | null =
    typeof EventSource === "undefined" ? null : (url) => new EventSource(url, { withCredentials: true }),
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
    async createTemplate(input) {
      return toTemplate(await post<WireTemplate>("/api/swarm-templates", templateBody(input)));
    },
    async updateTemplate(templateId, input) {
      return toTemplate(await patch<WireTemplate>(`/api/swarm-templates/${templateId}`, templateBody(input)));
    },
    async deleteTemplate(templateId) {
      await call<void>(`/api/swarm-templates/${templateId}`, { method: "DELETE" });
    },
    async saveSwarmAsTemplate(swarmId, name) {
      return toTemplate(await post<WireTemplate>(`/api/swarms/${swarmId}/template`, { name }));
    },
    async listAgents() {
      const rows = await call<{ id: string; name: string }[]>("/api/profiles");
      return rows.map((row) => ({ id: row.id, name: row.name }));
    },
    async createSwarm(input) {
      /*
       * What the route takes, and nothing else. The dialog still
       * collects two things the server has no home for (attachments,
       * and plan only, which is how every swarm begins anyway); they
       * are not sent, because a field the server drops is a promise
       * the console did not keep.
       *
       * The starting branch is sent now that there is a column for
       * it. Only when it is an existing one: a new branch is named by
       * the server after the swarm, and sending the console's preview
       * of that name would let the two disagree.
       */
      const created = await post<WireSwarm>("/api/swarms", {
        projectId: input.projectId,
        title: input.name,
        goal: input.goal,
        ...(input.templateId ? { templateId: input.templateId } : {}),
        maxWorkers: input.workers,
        ...(input.budgetUsd === null ? {} : { budgetUsd: input.budgetUsd }),
        ...(input.start.kind === "existing-branch" ? { startBranch: input.start.name } : {}),
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
    async reopenSwarm(swarmId, input) {
      // The ceilings travel only when the dialog collected them. An
      // absent field leaves the swarm's own, which is what "reopen
      // without raising anything" has to mean on the server too.
      await post(`/api/swarms/${swarmId}/reopen`, {
        instruction: input.instruction,
        ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
        ...(input.timeLimitMin === undefined ? {} : { timeLimitMin: input.timeLimitMin }),
      });
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
    async markTaskDone(swarmId, taskId) {
      await post(`/api/swarms/${swarmId}/tasks/${taskId}/done`);
    },
    async retryTask(swarmId, taskId) {
      await post(`/api/swarms/${swarmId}/tasks/${taskId}/retry`);
    },
    async cancelTask(swarmId, taskId) {
      await post(`/api/swarms/${swarmId}/tasks/${taskId}/cancel`);
    },
    async splitTask(swarmId, taskId, children) {
      await post(`/api/swarms/${swarmId}/tasks/${taskId}/split`, { children });
    },
    async addTask(swarmId, parentId, task) {
      await post(`/api/swarms/${swarmId}/tasks`, { parentId, ...task });
    },
    async reassignTask(swarmId, taskId, agentProfileId) {
      await post(`/api/swarms/${swarmId}/tasks/${taskId}/reassign`, { agentProfileId });
    },
    async editTask(swarmId, taskId, edit) {
      await patch(`/api/swarms/${swarmId}/tasks/${taskId}`, edit);
    },
    async listArtifacts(swarmId) {
      return call<SwarmArtifact[]>(`/api/swarms/${swarmId}/artifacts`);
    },
    async getNode(swarmId, taskId) {
      const node = await call<WireNode>(`/api/swarms/${swarmId}/tasks/${taskId}`);
      return toNode(taskId, node);
    },
    async messageTask(swarmId, taskId, text) {
      await post(`/api/swarms/${swarmId}/messages`, { text, taskId });
    },
    streamSwarm(swarmId, onEvent, onReconnect) {
      // No EventSource is not an error: the console still works, it
      // just reads the board when it is asked to rather than as it
      // changes. Server rendering and the tests take this path.
      if (!openStream) return () => {};
      const source = openStream(`${baseUrl}/api/swarms/${swarmId}/events`);
      let opened = false;
      source.addEventListener("open", () => {
        // The first open is the subscription; a later one is the
        // stream coming back, and whatever it missed is not replayed.
        if (opened) onReconnect?.();
        opened = true;
      });
      source.addEventListener("swarm_event", () => onEvent());
      return () => source.close();
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
    landings: (detail.landings ?? []).map(toLanding),
    // The ledger is not served yet. Empty, so nothing is drawn rather
    // than drawn wrong; the panel that reads it renders only when it
    // holds something.
    ledger: [],
    pullRequests: (detail.pullRequests ?? []).map(toPullRequest),
  };
}

/**
 * One pull request the swarm opened.
 *
 * The url is checked rather than copied. Everything else on this row
 * is drawn as text, and text is safe whatever wrote it; a url becomes
 * an `href`, and an `href` with a `javascript:` scheme runs on the
 * console's origin with the session that is open. `externalHttpUrl`
 * answers with an address or with null, and the header draws a chip
 * without a link for null.
 */
export function toPullRequest(row: WirePullRequest): SwarmPullRequest {
  return {
    id: row.id,
    repoUrl: row.repoUrl,
    number: row.number,
    url: externalHttpUrl(row.url),
    headSha: row.headSha,
  };
}

/**
 * One node's commits and history, as the drawer reads them.
 *
 * The server calls a commit's first line its subject, which is git's
 * word for it; the console has called it the message since the card
 * board, so the translation happens here rather than in the drawer.
 */
export function toNode(taskId: string, node: WireNode): SwarmNodeDetail {
  return {
    taskId,
    commits: (node.commits ?? []).map((commit) => ({
      sha: commit.sha,
      message: commit.subject,
      at: commit.at,
      ...(commit.repository ? { repository: commit.repository } : {}),
    })),
    events: (node.events ?? []).map((event) => ({
      id: event.id,
      kind: event.kind,
      at: event.at,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      runId: event.runId,
      detail: event.detail,
    })),
  };
}

/**
 * One merge queue row.
 *
 * Copied field for field rather than spread, so a column added to the
 * server's response reaches the page only once somebody has decided
 * what it means here.
 */
function toLanding(landing: WireLanding): SwarmLanding {
  return {
    id: landing.id,
    taskId: landing.taskId,
    branchName: landing.branchName,
    position: landing.position,
    status: landing.status,
    attempt: landing.attempt,
    error: landing.error,
    resolverRunId: landing.resolverRunId,
    startedAt: landing.startedAt,
    endedAt: landing.endedAt,
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
    /*
     * A body the route's validator refused, rather than one it wrote.
     *
     * zValidator answers with the whole ZodError, and `error` is then
     * an object, so the line above falls through and the console used
     * to print `{"success":false,"error":{"name":"ZodError","issues"...`
     * at a person. The first issue is the one worth saying, named by
     * the field it is about.
     */
    const issues = (parsed.error as { issues?: { path?: unknown[]; message?: string }[] } | undefined)?.issues;
    const first = Array.isArray(issues) ? issues[0] : undefined;
    if (first?.message) {
      const field = Array.isArray(first.path) ? first.path.filter((part) => typeof part === "string").join(".") : "";
      return field ? `${field}: ${first.message}` : first.message;
    }
  } catch {
    // Not JSON. The body is the best there is.
  }
  return body || "something went wrong";
}

/**
 * What the console uses: the server, through the routes above.
 */
export const swarmApi: SwarmApi = httpSwarmApi();
