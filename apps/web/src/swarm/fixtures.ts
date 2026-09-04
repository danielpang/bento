import type {
  NewSwarmInput,
  Swarm,
  SwarmDetail,
  SwarmSpend,
  SwarmSummary,
  SwarmTask,
  SwarmTemplate,
  TaskStatus,
} from "./types.js";

/**
 * Swarms that do not exist yet.
 *
 * The routes are not built. Everything the console renders comes
 * through `client.ts`, and this is what answers it today: a project's
 * strip, four swarms with real trees, the templates the dialog picks
 * from, and enough mutation to drive the whole console by hand. When
 * the endpoints land, `client.ts` points at them and this file is the
 * only thing that goes.
 *
 * Written as a function of `now` rather than of the clock, so a test
 * asking for the same instant gets the same tree, while the browser
 * gets a swarm whose workers have plausibly been going for a while.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function spend(measured = 0, estimated = 0, assumed = 0): SwarmSpend {
  return { measuredUsd: measured, estimatedUsd: estimated, assumedUsd: assumed };
}

function iso(now: number, offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

interface TaskSeed {
  id: string;
  parentId: string | null;
  title: string;
  nodeType: "plan" | "leaf";
  status: TaskStatus;
  weight?: number;
  attention?: SwarmTask["attention"];
  startedMinAgo?: number;
  endedMinAgo?: number;
  cost?: SwarmSpend;
  description?: string;
  criteria?: string[];
  report?: string;
  flags?: Record<string, unknown>;
  branchName?: string;
}

function task(seed: TaskSeed, position: number, now: number): SwarmTask {
  return {
    id: seed.id,
    parentId: seed.parentId,
    position,
    title: seed.title,
    description:
      seed.description ??
      "Written by the planner from the goal. Renders as text, never as markup, because an agent wrote it.",
    nodeType: seed.nodeType,
    status: seed.status,
    attention: seed.attention ?? "none",
    weight: seed.weight ?? 1,
    assignedRunId:
      seed.status === "working" || seed.status === "assigned" ? `run-${seed.id}` : null,
    branchName: seed.branchName ?? (seed.nodeType === "leaf" ? `bento/${seed.id}` : null),
    cost: seed.cost ?? spend(),
    flags: seed.flags ?? {},
    report: seed.report ?? null,
    acceptanceCriteria: seed.criteria ?? [],
    startedAt: seed.startedMinAgo === undefined ? null : iso(now, -seed.startedMinAgo * MINUTE),
    endedAt: seed.endedMinAgo === undefined ? null : iso(now, -seed.endedMinAgo * MINUTE),
    commits:
      seed.status === "done" || seed.status === "landed"
        ? [
            {
              sha: `${seed.id.slice(-6)}a1b2c3`,
              message: `${seed.title}: first pass`,
              at: iso(now, -((seed.endedMinAgo ?? 30) + 6) * MINUTE),
            },
          ]
        : [],
  };
}

const CHECKOUT_SEEDS: TaskSeed[] = [
  { id: "t-root", parentId: null, title: "Ship the new checkout", nodeType: "plan", status: "working", weight: 5, startedMinAgo: 96 },
  { id: "t-pay", parentId: "t-root", title: "Payments", nodeType: "plan", status: "working", startedMinAgo: 92 },
  {
    id: "t-pay-token",
    parentId: "t-pay",
    title: "Card tokenisation",
    nodeType: "leaf",
    status: "done",
    weight: 3,
    startedMinAgo: 92,
    endedMinAgo: 61,
    cost: spend(1.42),
    criteria: ["Tokens never touch our database", "The old path still works behind the flag"],
    report: "Swapped the card field for the hosted one and moved the token exchange to the server.",
  },
  {
    id: "t-pay-wallet",
    parentId: "t-pay",
    title: "Apple Pay",
    nodeType: "leaf",
    status: "done",
    weight: 2,
    startedMinAgo: 88,
    endedMinAgo: 40,
    cost: spend(0.86, 0.12),
    criteria: ["The sheet opens on a real device", "Falls back to the card form when unavailable"],
    report: "Wallet button renders behind the same flag, with the card form as the fallback.",
  },
  {
    id: "t-pay-refund",
    parentId: "t-pay",
    title: "Refund path",
    nodeType: "leaf",
    status: "working",
    weight: 3,
    startedMinAgo: 38,
    cost: spend(0.51, 0.2),
    criteria: ["A partial refund leaves the order open"],
  },
  { id: "t-cart", parentId: "t-root", title: "Cart", nodeType: "plan", status: "done", startedMinAgo: 94, endedMinAgo: 55 },
  {
    id: "t-cart-totals",
    parentId: "t-cart",
    title: "Line item totals",
    nodeType: "leaf",
    status: "done",
    weight: 2,
    startedMinAgo: 94,
    endedMinAgo: 70,
    cost: spend(0.64),
    report: "Totals moved to the server so the two clients cannot disagree.",
  },
  {
    id: "t-cart-promo",
    parentId: "t-cart",
    title: "Promo codes",
    nodeType: "leaf",
    status: "done",
    startedMinAgo: 80,
    endedMinAgo: 55,
    cost: spend(0.38),
    report: "One code per cart, checked on the server.",
  },
  { id: "t-ui", parentId: "t-root", title: "Checkout UI", nodeType: "plan", status: "working", startedMinAgo: 70 },
  {
    id: "t-ui-address",
    parentId: "t-ui",
    title: "Address form",
    nodeType: "leaf",
    status: "working",
    weight: 2,
    startedMinAgo: 7,
    cost: spend(0.11),
    criteria: ["Autofill still works", "Errors read as sentences"],
  },
  { id: "t-ui-summary", parentId: "t-ui", title: "Order summary", nodeType: "leaf", status: "assigned", weight: 2, startedMinAgo: 1 },
  { id: "t-ui-errors", parentId: "t-ui", title: "Error states", nodeType: "leaf", status: "open", weight: 1 },
  {
    id: "t-docs",
    parentId: "t-root",
    title: "Update the checkout docs",
    nodeType: "leaf",
    status: "blocked",
    attention: "escalated",
    weight: 1,
    startedMinAgo: 44,
    cost: spend(0, 0, 0.25),
    flags: { blockedBy: "t-pay-refund", attempts: 2 },
    criteria: ["Every screenshot matches the new flow"],
  },
  { id: "t-tests", parentId: "t-root", title: "Tests", nodeType: "plan", status: "working", startedMinAgo: 66 },
  {
    id: "t-tests-happy",
    parentId: "t-tests",
    title: "End to end happy path",
    nodeType: "leaf",
    status: "landed",
    weight: 2,
    startedMinAgo: 66,
    endedMinAgo: 12,
    cost: spend(0.72, 0.05),
    report: "Covers card and wallet. Landed on the swarm branch, waiting on the refund path before it can be called done.",
  },
  {
    id: "t-tests-failure",
    parentId: "t-tests",
    title: "Failure cases",
    nodeType: "leaf",
    status: "failed",
    weight: 2,
    startedMinAgo: 50,
    endedMinAgo: 30,
    cost: spend(0.44),
    flags: { attempts: 3, lastError: "The gateway sandbox refused three declined cards in a row." },
  },
  {
    id: "t-tests-dupe",
    parentId: "t-tests",
    title: "Duplicate coverage, dropped",
    nodeType: "leaf",
    status: "cancelled",
    weight: 1,
    startedMinAgo: 48,
    endedMinAgo: 47,
  },
];

const DOCS_SEEDS: TaskSeed[] = [
  { id: "d-root", parentId: null, title: "Refresh the API reference", nodeType: "plan", status: "open", weight: 3 },
];

const API_SEEDS: TaskSeed[] = [
  { id: "a-root", parentId: null, title: "Retire the v1 endpoints", nodeType: "plan", status: "done", startedMinAgo: 400, endedMinAgo: 180 },
  {
    id: "a-audit",
    parentId: "a-root",
    title: "Find every caller",
    nodeType: "leaf",
    status: "done",
    weight: 2,
    startedMinAgo: 400,
    endedMinAgo: 320,
    cost: spend(0.92),
    report: "Nine callers, six of them internal.",
  },
  {
    id: "a-shim",
    parentId: "a-root",
    title: "Shim the three external callers",
    nodeType: "leaf",
    status: "done",
    weight: 3,
    startedMinAgo: 320,
    endedMinAgo: 180,
    cost: spend(1.86, 0.4),
    report: "A redirect shim, with a sunset header on every v1 response.",
  },
];

/**
 * A tree of any size, for the sizes a screenshot never covers.
 *
 * Two hundred nodes is a real plan for a migration, and it is the
 * size the layout has to hold a frame at. Deterministic, so a
 * performance test and the browser see the same tree.
 */
export function generateSwarmTasks(count: number, opts: { branching?: number; doneEvery?: number } = {}): SwarmTask[] {
  const branching = opts.branching ?? 4;
  const doneEvery = opts.doneEvery ?? 3;
  const seeds: TaskSeed[] = [];
  for (let i = 0; i < count; i += 1) {
    const parentIndex = i === 0 ? null : Math.floor((i - 1) / branching);
    const isPlan = i * branching + 1 < count;
    const status: TaskStatus = isPlan
      ? "working"
      : i % doneEvery === 0
        ? "done"
        : i % doneEvery === 1
          ? "working"
          : "open";
    seeds.push({
      id: `g-${i}`,
      parentId: parentIndex === null ? null : `g-${parentIndex}`,
      title: `Task ${i}`,
      nodeType: isPlan ? "plan" : "leaf",
      status,
      weight: (i % 5) + 1,
      cost: spend((i % 7) / 100, (i % 3) / 100, (i % 2) / 100),
      startedMinAgo: status === "open" ? undefined : 30 + (i % 40),
      endedMinAgo: status === "done" ? 5 + (i % 20) : undefined,
    });
  }
  return seeds.map((seed, index) => task(seed, index, 0));
}

function tasksFrom(seeds: TaskSeed[], now: number): SwarmTask[] {
  const nextPosition = new Map<string, number>();
  return seeds.map((seed) => {
    const key = seed.parentId ?? "";
    const position = nextPosition.get(key) ?? 0;
    nextPosition.set(key, position + 1);
    return task(seed, position, now);
  });
}

function swarmShell(overrides: Partial<Swarm> & Pick<Swarm, "id" | "name" | "status">, now: number): Swarm {
  return {
    projectId: "",
    slug: overrides.id,
    goal: "",
    pausedReason: null,
    branchName: `bento/${overrides.id}`,
    deliverable: "code",
    templateId: "tpl-code",
    budgetUsd: 40,
    maxWorkers: 8,
    workers: 4,
    workersActive: 0,
    timeLimitMin: null,
    spend: spend(),
    startedAt: iso(now, -2 * HOUR),
    endedAt: null,
    createdAt: iso(now, -3 * HOUR),
    archivedAt: null,
    lastOpenedAt: null,
    question: null,
    ...overrides,
  };
}

/** The seeded swarms, newest last, as the strip orders them. */
export function seedSwarms(projectId: string, now: number): SwarmDetail[] {
  const checkoutTasks = tasksFrom(CHECKOUT_SEEDS, now);
  const apiTasks = tasksFrom(API_SEEDS, now);
  const docsTasks = tasksFrom(DOCS_SEEDS, now);
  const bigTasks = generateSwarmTasks(200);

  return [
    {
      swarm: swarmShell(
        {
          id: "sw-api",
          name: "Retire v1",
          status: "done",
          projectId,
          goal: "Remove the v1 endpoints and leave the three external callers working.",
          createdAt: iso(now, -30 * HOUR),
          startedAt: iso(now, -29 * HOUR),
          endedAt: iso(now, -3 * HOUR),
          spend: spend(2.78, 0.4),
          workers: 3,
          budgetUsd: 25,
        },
        now,
      ),
      tasks: apiTasks,
      landings: [],
      ledger: [],
      pullRequests: [
        { id: "pr-api", repoUrl: "github.com/acme/storefront", number: 4127, url: "https://github.com/acme/storefront/pull/4127", headSha: "9f2c1ab" },
      ],
    },
    {
      swarm: swarmShell(
        {
          id: "sw-spike",
          name: "Queue spike",
          status: "stopped",
          projectId,
          goal: "See whether the outbox pattern fits before committing to it.",
          createdAt: iso(now, -20 * HOUR),
          archivedAt: iso(now, -6 * HOUR),
          endedAt: iso(now, -7 * HOUR),
          spend: spend(0.4, 0, 0.5),
          workers: 2,
        },
        now,
      ),
      tasks: tasksFrom(
        [{ id: "s-root", parentId: null, title: "Outbox spike", nodeType: "leaf", status: "cancelled", startedMinAgo: 800, endedMinAgo: 700 }],
        now,
      ),
      landings: [],
      ledger: [],
      pullRequests: [],
    },
    {
      swarm: swarmShell(
        {
          id: "sw-checkout",
          name: "Checkout rewrite",
          status: "running",
          projectId,
          goal: "Replace the checkout with the hosted card field, keep the old path behind a flag, and leave the docs current.",
          createdAt: iso(now, -2 * HOUR),
          startedAt: iso(now, -96 * MINUTE),
          spend: spend(5.08, 0.37, 0.25),
          workers: 4,
          workersActive: 2,
          budgetUsd: 40,
          question: {
            id: "q1",
            text: "The refund path can either reuse the v1 gateway client or take the new one. The new one has no partial refund yet. Which would you rather I build against?",
            askedAt: iso(now, -4 * MINUTE),
            taskId: "t-pay-refund",
          },
        },
        now,
      ),
      tasks: checkoutTasks,
      landings: [
        { id: "ld-1", taskId: "t-tests-happy", branchName: "bento/t-tests-happy", position: 0, status: "landed", attempt: 1, error: null },
        { id: "ld-2", taskId: "t-pay-refund", branchName: "bento/t-pay-refund", position: 1, status: "queued", attempt: 0, error: null },
      ],
      ledger: [
        { id: "lg-1", at: iso(now, -61 * MINUTE), taskId: "t-pay-token", source: "claude-code", tier: "measured", usd: 1.42 },
        { id: "lg-2", at: iso(now, -40 * MINUTE), taskId: "t-pay-wallet", source: "codex", tier: "estimated", usd: 0.12 },
        { id: "lg-3", at: iso(now, -44 * MINUTE), taskId: "t-docs", source: "writer", tier: "assumed", usd: 0.25 },
      ],
      pullRequests: [],
    },
    {
      swarm: swarmShell(
        {
          id: "sw-docs",
          name: "API reference",
          status: "planning",
          projectId,
          goal: "Bring the API reference back in line with the handlers.",
          createdAt: iso(now, -12 * MINUTE),
          startedAt: iso(now, -11 * MINUTE),
          spend: spend(0.06),
          deliverable: "document",
          workers: 2,
          budgetUsd: 10,
          templateId: "tpl-doc",
        },
        now,
      ),
      tasks: docsTasks,
      landings: [],
      ledger: [],
      pullRequests: [],
    },
    {
      swarm: swarmShell(
        {
          id: "sw-migration",
          name: "Monorepo migration",
          status: "running",
          projectId,
          goal: "Move every package onto the shared build, one at a time.",
          createdAt: iso(now, -5 * MINUTE),
          startedAt: iso(now, -5 * MINUTE),
          spend: spend(3.11, 1.2, 0.9),
          workers: 8,
          workersActive: 6,
          budgetUsd: 120,
        },
        now,
      ),
      tasks: bigTasks,
      landings: [],
      ledger: [],
      pullRequests: [],
    },
  ];
}

export function summarise(detail: SwarmDetail, completion: number): SwarmSummary {
  return {
    id: detail.swarm.id,
    projectId: detail.swarm.projectId,
    name: detail.swarm.name,
    status: detail.swarm.status,
    createdAt: detail.swarm.createdAt,
    archivedAt: detail.swarm.archivedAt,
    lastOpenedAt: detail.swarm.lastOpenedAt,
    completion,
  };
}

/**
 * The templates the New swarm dialog offers, with the cost shape
 * beside each: which model plans, which model works, and which tier
 * every tool reports in.
 */
export const SWARM_TEMPLATES: SwarmTemplate[] = [
  {
    id: "tpl-code",
    name: "Code change",
    description: "A planner splits the goal into leaves, each worked on its own branch and landed one at a time.",
    plannerModel: "claude-opus-4",
    workerModel: "claude-sonnet-4",
    tools: [
      { name: "claude-code", tier: "measured" },
      { name: "codex", tier: "estimated" },
      { name: "gemini-cli", tier: "assumed" },
    ],
    assumedUsdPerLeaf: 0.2,
    perLeaf: { measuredUsd: 0.55, estimatedUsd: 0.12, assumedUsd: 0.2 },
    maxWorkers: 12,
    maxBudgetUsd: 200,
    timeLimitMin: 240,
    typicalLeaves: 12,
  },
  {
    id: "tpl-doc",
    name: "Document",
    description: "The same split, with the deliverable a written document rather than a branch.",
    plannerModel: "claude-opus-4",
    workerModel: "claude-haiku-4",
    tools: [
      { name: "claude-code", tier: "measured" },
      { name: "writer", tier: "assumed" },
    ],
    assumedUsdPerLeaf: 0.1,
    perLeaf: { measuredUsd: 0.18, estimatedUsd: 0, assumedUsd: 0.1 },
    maxWorkers: 6,
    maxBudgetUsd: 50,
    timeLimitMin: 120,
    typicalLeaves: 8,
  },
  {
    id: "tpl-survey",
    name: "Survey the codebase",
    description: "Read only. Workers report what they found and nothing is landed.",
    plannerModel: "claude-sonnet-4",
    workerModel: "claude-haiku-4",
    tools: [{ name: "claude-code", tier: "measured" }],
    assumedUsdPerLeaf: 0,
    perLeaf: { measuredUsd: 0.09, estimatedUsd: 0, assumedUsd: 0 },
    maxWorkers: 16,
    maxBudgetUsd: 25,
    timeLimitMin: 60,
    typicalLeaves: 20,
  },
];

/** A swarm as it exists the moment it is created: a goal, and nothing planned yet. */
export function draftSwarm(input: NewSwarmInput, now: number): SwarmDetail {
  const id = `sw-${Math.random().toString(36).slice(2, 8)}`;
  const template = SWARM_TEMPLATES.find((entry) => entry.id === input.templateId) ?? SWARM_TEMPLATES[0]!;
  return {
    swarm: swarmShell(
      {
        id,
        name: input.name,
        status: "planning",
        projectId: input.projectId,
        goal: input.goal,
        branchName: input.start.name,
        deliverable: input.deliverable,
        templateId: template.id,
        budgetUsd: input.budgetUsd,
        maxWorkers: template.maxWorkers,
        workers: input.workers,
        createdAt: iso(now, 0),
        startedAt: iso(now, 0),
        spend: spend(),
      },
      now,
    ),
    tasks: tasksFrom(
      [{ id: `${id}-root`, parentId: null, title: input.name, nodeType: "plan", status: "open", weight: 3 }],
      now,
    ),
    landings: [],
    ledger: [],
    pullRequests: [],
  };
}
