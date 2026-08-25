/**
 * Fixture data for the preview cards, and a client that serves it.
 *
 * The console's panels take a live `BentoClient` and fetch on mount, so
 * outside the app they render empty. These fixtures are what let them
 * render the way they look in use: a board mid-pipeline, an agent that
 * has run, a repository with its commands filled in.
 *
 * Not a mock of the API contract — a set of plausible rows. Anything a
 * panel asks for that isn't here resolves to null rather than throwing,
 * so a panel calling a method this file has never heard of degrades to
 * an empty section instead of a blank card.
 *
 * This file is not a component preview: nothing is named for a
 * component, so the converter never binds it to a card.
 */

const now = Date.UTC(2026, 6, 14, 9, 30);
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

export const profiles = [
  { id: "p1", name: "Product Manager", cli: "claude-code", model: "claude-sonnet-5", skill: "Investigate the problem before proposing anything.", extraArgs: [] },
  { id: "p2", name: "Staff Engineer", cli: "claude-code", model: "claude-opus-5", skill: "Turn the design into a plan somebody could build from.", extraArgs: [] },
  { id: "p3", name: "Code Reviewer", cli: "opencode", model: "openrouter/openai/gpt-5.6-sol", skill: "Review the changes against what the earlier stages asked for.", extraArgs: [] },
];

export const stages = [
  { id: "s1", pipelineId: "pl1", position: 0, name: "Product investigation", slug: "product-investigation", description: "Investigate the problem space.", defaultAgentProfileId: "p1", gateType: "manual", gateCriteria: [], createPr: false },
  { id: "s2", pipelineId: "pl1", position: 1, name: "Implementation", slug: "implementation", description: "Build the change.", defaultAgentProfileId: "p2", gateType: "auto", gateCriteria: [{ type: "checks_pass" }], createPr: true },
  { id: "s3", pipelineId: "pl1", position: 2, name: "Code review", slug: "code-review", description: "Review before merge.", defaultAgentProfileId: "p3", gateType: "manual", gateCriteria: [], createPr: false },
];

export const feature = {
  id: "f1",
  projectId: "prj1",
  pipelineId: "pl1",
  currentStageId: "s2",
  title: "Rate limit the public API",
  description: "Third-party scripts are hammering /api/search. Add a per-token limit with a clear 429.",
  status: "gated",
  boardPosition: 0,
  branchName: "feature/rate-limit-public-api",
  prNumber: 142,
  prUrl: "https://github.com/acme/api/pull/142",
  createdAt: at(180),
  updatedAt: at(12),
};

export const features = [
  feature,
  { ...feature, id: "f2", title: "Retry webhooks that time out", status: "active", currentStageId: "s1", prNumber: null, prUrl: null, boardPosition: 1 },
  { ...feature, id: "f3", title: "Move the audit log off the hot path", status: "backlog", currentStageId: null, prNumber: null, prUrl: null, boardPosition: 2 },
];

export const runs = [
  { id: "r1", featureId: "f1", stageId: "s2", agentProfileId: "p2", sandboxId: "sb1", status: "succeeded", executor: "server", costUsd: 0.42, numTurns: 9, error: null, queuedAt: at(40), startedAt: at(39), endedAt: at(21), cliSessionId: "sess-1" },
  { id: "r0", featureId: "f1", stageId: "s1", agentProfileId: "p1", sandboxId: "sb1", status: "succeeded", executor: "server", costUsd: 0.11, numTurns: 4, error: null, queuedAt: at(170), startedAt: at(169), endedAt: at(160), cliSessionId: "sess-0" },
];

/**
 * A card whose newest run is still going: `runs[0]` is what
 * `AgentSession` reads as "the latest run", so the Working preview
 * shows Stop beside the composer while the transcript above it still
 * reads from the finished blocks fixture.
 */
export const workingRuns = [
  { id: "r2", featureId: "f1", stageId: "s2", agentProfileId: "p2", sandboxId: "sb1", status: "running", executor: "server", costUsd: null, numTurns: 2, error: null, queuedAt: at(2), startedAt: at(1), endedAt: null, cliSessionId: "sess-2" },
  ...runs,
];

export const repositories = [
  { id: "rp1", projectId: "prj1", name: "api", localPath: "/Users/you/code/api", repoUrl: "https://github.com/acme/api", githubRepoId: null, defaultBranch: "main", position: 0, setupCommand: "npm ci", testCommand: "npm test" },
  { id: "rp2", projectId: "prj1", name: "web", localPath: "/Users/you/code/web", repoUrl: "https://github.com/acme/web", githubRepoId: null, defaultBranch: "main", position: 1, setupCommand: null, testCommand: "npm run test:ci" },
];

export const changes = {
  branch: "feature/rate-limit-public-api",
  repositories: [
    {
      name: "api",
      branch: "feature/rate-limit-public-api",
      files: [{ path: "src/middleware/rate-limit.ts", additions: 64, deletions: 0 }, { path: "src/app.ts", additions: 3, deletions: 1 }],
      diff: [
        "diff --git a/src/middleware/rate-limit.ts b/src/middleware/rate-limit.ts",
        "+++ b/src/middleware/rate-limit.ts",
        "@@ -0,0 +1,8 @@",
        "+/** One bucket per token, refilled on read. */",
        "+export function rateLimit(perMinute: number) {",
        "+  const buckets = new Map<string, Bucket>();",
        "+  return async (c: Context, next: Next) => {",
        "+    const token = c.get('token');",
        "+    if (!take(buckets, token, perMinute)) return c.json({ error: 'slow down' }, 429);",
        "+    await next();",
        "+  };",
        "+}",
      ].join("\n"),
      truncated: false,
      artifacts: [],
    },
  ],
};

export const gate = {
  status: "waiting",
  checks: [
    { criterion: { type: "checks_pass" }, status: "passed", detail: { message: "3 of 3 checks passed on #142" } },
    { criterion: { type: "manual" }, status: "pending", detail: { message: "Waiting for approval" } },
  ],
};

/**
 * The card's own log. `stage_moved` is the kind the drawer renders as a
 * move; anything else it reads as a status change, so those rows carry
 * `fromStatus`/`toStatus` or they render as "new to unknown".
 */
export const history = [
  { id: "e4", featureId: "f1", kind: "status_changed", fromStatus: "active", toStatus: "gated", trigger: "gate_auto", actorName: null, actorEmail: null, at: at(20) },
  { id: "e3", featureId: "f1", kind: "stage_moved", fromStageId: "s1", toStageId: "s2", trigger: "gate_auto", actorName: null, actorEmail: null, at: at(41) },
  { id: "e2", featureId: "f1", kind: "status_changed", fromStatus: "backlog", toStatus: "active", trigger: "manual", actorName: "Ada Lovelace", actorEmail: "ada@acme.test", at: at(170) },
  { id: "e1", featureId: "f1", kind: "status_changed", fromStatus: null, toStatus: "backlog", trigger: "manual", actorName: "Ada Lovelace", actorEmail: "ada@acme.test", at: at(180) },
];

/** What each client method answers with. Absent method → null. */
const answers: Record<string, unknown> = {
  listProjects: [{ id: "prj1", name: "Acme API", localPath: "/Users/you/code/api", repoUrl: "https://github.com/acme/api", defaultBranch: "main" }],
  listRepositories: repositories,
  listProfiles: profiles,
  listFeatures: features,
  listSecrets: [
    { id: "sec1", name: "ANTHROPIC_API_KEY", hint: "••••••4f2a" },
    { id: "sec2", name: "GITHUB_TOKEN", hint: "••••••b17c" },
  ],
  listAgentTools: [
    { cli: "claude-code", label: "Claude Code", binary: "claude", installed: true, installUrl: "https://docs.claude.com/en/docs/claude-code/setup", installCommand: "curl -fsSL https://claude.ai/install.sh | bash" },
    { cli: "codex", label: "Codex CLI", binary: "codex", installed: true, installUrl: "https://github.com/openai/codex", installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
    { cli: "opencode", label: "opencode", binary: "opencode", installed: true, installUrl: "https://opencode.ai/docs/", installCommand: "curl -fsSL https://opencode.ai/install | bash" },
    { cli: "pi", label: "pi", binary: "pi", installed: false, installUrl: "https://github.com/earendil-works/pi", installCommand: "npm install -g @earendil-works/pi-coding-agent" },
  ],
  getPipeline: { id: "pl1", projectId: "prj1", name: "Default", isDefault: true, stages },
  getFeature: { ...feature, runs, pullRequests: [{ name: "api", number: 142, url: "https://github.com/acme/api/pull/142" }] },
  getGate: gate,
  getHistory: history,
  getChanges: changes,
  // The session pane reads `.blocks`, so the empty answer is an object
  // with an empty list — not an empty list.
  getConversation: {
    blocks: [
      {
        runId: "r1",
        agentName: "Staff Engineer",
        agentCli: "claude-code",
        model: "claude-opus-5",
        queuedAt: at(40),
        startedAt: at(39),
        endedAt: at(21),
        status: "succeeded",
        costUsd: 0.42,
        events: [
          { type: "message", role: "user", text: "Add a per-token rate limit in front of the router. Return 429 with a retry window when a token is over quota." },
          { type: "message", role: "assistant", text: "Read the middleware and the route table first. The limit belongs in front of the router, not per handler." },
          { type: "tool", name: "read", phase: "start", detail: { path: "src/app.ts" } },
          { type: "tool", name: "read", phase: "end" },
          { type: "tool", name: "edit", phase: "start", detail: { file_path: "src/middleware/rate-limit.ts" } },
          { type: "tool", name: "edit", phase: "end" },
          { type: "message", role: "system", text: "Gate checks passed on pull request #142." },
          { type: "message", role: "assistant", text: "Added a token bucket per API token, refilled on read, and wired it ahead of the router. 429 carries the retry window." },
          { type: "result", ok: true, costUsd: 0.42, numTurns: 9 },
        ],
      },
    ],
  },
  githubStatus: { configured: false, connected: false, canPublish: true, canManage: true, installation: null },
  githubSettings: { includeStageNotesInPr: false, canManage: true },
  listGitHubRepositories: [],
  getMachineSettings: { mode: "local", shareAgentAuth: false, logins: [{ cli: "claude-code", signedIn: true }] },
  getUsage: {
    totalUsd: 9.03,
    runsWithoutCost: 4,
    totalRuns: 14,
    byStage: [],
    byFeature: [
      { featureId: "f1", title: "Rate limit middleware", runs: 3, costUsd: 0.53, runsWithoutCost: 0 },
      { featureId: "f2", title: "Login polish", runs: 2, costUsd: null, runsWithoutCost: 2 },
    ],
  },
};

/**
 * A client that answers from the fixtures above.
 *
 * A Proxy rather than an object literal: the panels call a wide and
 * moving set of methods, and a preview should not break the day a
 * component starts calling a new one.
 */
export const client = new Proxy(
  {},
  {
    get(_target, prop: string) {
      // Subscriptions hand back an unsubscribe function, not a promise.
      if (prop.startsWith("stream")) return () => () => {};
      return (..._args: unknown[]) => Promise.resolve(answers[prop] ?? null);
    },
  },
) as never;

/** Panels are drawers: they position against the viewport, so a card needs one. */
export function Frame({ children, height = 560 }: { children: React.ReactNode; height?: number }) {
  return (
    <div style={{ position: "relative", height, overflow: "hidden", background: "var(--bg)" }}>{children}</div>
  );
}

/**
 * The page these components are drawn for.
 *
 * A preview card has no background of its own, so a component that
 * expects the app's dark surface renders on white — and anything tuned
 * for that surface disappears. The provider logos are the loud case:
 * they ship near-black and are inverted by `--logo-filter`, so on white
 * they are white on white. Give bare content the surface it was
 * designed against.
 */
export function Surface({ children, pad = 16 }: { children: React.ReactNode; pad?: number }) {
  return (
    <div style={{ background: "var(--bg)", color: "var(--text)", padding: pad }}>{children}</div>
  );
}
