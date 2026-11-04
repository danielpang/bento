import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import pg from "pg";
import {
  createDb,
  createPool,
  featureEvents,
  features,
  linearConnections,
  linearIssueLinks,
  linearTeamMappings,
  organization,
  pipelines,
  projects,
  runMigrations,
  stages,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { singleDriver } from "./orchestrator/sandbox-driver.js";
import type { LinearWebhookIssue } from "@bento/linear";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import {
  handleLinearInbound,
  registerLinearJobs,
  syncLinearBacklog,
} from "./orchestrator/linear-sync.js";

/**
 * The Linear to Bento direction, and the setting that decides whether an
 * arriving issue waits in the backlog or starts its pipeline.
 *
 * Real database, real queue, real webhook route: the first test signs a
 * payload the way Linear does and reads the card back out of Postgres,
 * because "the card moved" is the whole feature and a stubbed advance
 * would prove only that a function was called. Linear itself is the one
 * stub, since there is no workspace to import from.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "linear_inbound_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);
const webhookSecret = "hook-secret";

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let projectId: string;
let firstStageId: string;
const originalFetch = globalThis.fetch;

/** The issues the stub's team backlog holds, for the sweep. */
const backlogIssues: {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId?: string;
  projectId?: string;
}[] = [];

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-linear-in-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  const userId = await ensureLocalUser(db);

  ctx = {
    env,
    db,
    pool,
    boss,
    bus: new EventBus(),
    drivers: singleDriver(new LocalProcessDriver()),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    draining: false,
    userId,
  };
  await registerLinearJobs(ctx);
  // A stage with no agent asks for a gate evaluation, the way the real
  // server's queue is ready for.
  await ctx.boss.createQueue("gate.evaluate");
  app = createApp(ctx);

  globalThis.fetch = stubLinear();

  projectId = await setupProject(userId, "Inbound", null);
  const [stage] = await db
    .select({ id: stages.id })
    .from(stages)
    .orderBy(asc(stages.position))
    .limit(1);
  firstStageId = stage!.id;

  await db.insert(linearConnections).values({
    ownerId: userId,
    organizationId: null,
    encryptedApiKey: ctx.secretBox.encrypt("lin_api_test"),
    encryptedWebhookSecret: ctx.secretBox.encrypt(webhookSecret),
    webhookId: "wh-1",
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

/** A project with a two stage pipeline that follows one Linear project. */
async function setupProject(
  userId: string,
  name: string,
  organizationId: string | null,
): Promise<string> {
  const [project] = await ctx.db
    .insert(projects)
    .values({ ownerId: userId, name, organizationId })
    .returning({ id: projects.id });
  const [pipeline] = await ctx.db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "Default", isDefault: true })
    .returning({ id: pipelines.id });
  await ctx.db.insert(stages).values([
    { pipelineId: pipeline!.id, position: 0, name: "Investigation", slug: `${name}-investigation` },
    { pipelineId: pipeline!.id, position: 1, name: "Implementation", slug: `${name}-implementation` },
  ]);
  await followLinear(project!.id, `team-${name.toLowerCase()}`, `linear-${name.toLowerCase()}`);
  return project!.id;
}

/** Linear, reduced to the one query the sweep makes. */
function stubLinear(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    if (body.query.includes("query Issues(")) {
      // Filtered the way Linear filters, so a sweep that forgets the
      // project filter imports the wrong issues and fails the test.
      const filter = (body as { variables?: { filter?: IssueFilter } }).variables?.filter;
      const matching = backlogIssues.filter(
        (issue) =>
          (issue.teamId ?? "team-inbound") === filter?.team?.id?.eq &&
          (!filter.project || (issue.projectId ?? "linear-inbound") === filter.project.id.eq),
      );
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: matching.map(({ teamId, projectId, ...issue }) => ({
                ...issue,
                description: null,
                updatedAt: new Date(0).toISOString(),
                state: { id: "s", name: "Backlog", type: "backlog" },
                team: { id: teamId ?? "team-inbound" },
                project: { id: projectId ?? "linear-inbound" },
                labels: { nodes: [] },
              })),
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
}

interface IssueFilter {
  team?: { id?: { eq?: string } };
  project?: { id: { eq: string } };
}

/**
 * The webhook payload Linear sends for a brand new backlog issue, in the
 * Linear project that `setupProject` has the team's Bento project follow.
 */
function issueCreated(id: string, title: string, teamId = "team-inbound"): LinearWebhookIssue {
  return {
    id,
    identifier: `INB-${id}`,
    title,
    url: `https://linear.app/bento/issue/INB-${id}`,
    teamId,
    projectId: teamId.replace(/^team-/, "linear-"),
    state: { id: "s", name: "Backlog", type: "backlog" },
  };
}

async function cardFor(linearIssueId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [link] = await ctx.db
      .select({ featureId: linearIssueLinks.featureId })
      .from(linearIssueLinks)
      .where(eq(linearIssueLinks.linearIssueId, linearIssueId))
      .limit(1);
    if (link) {
      const [feature] = await ctx.db.select().from(features).where(eq(features.id, link.featureId));
      if (feature) return feature;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no card was imported for issue ${linearIssueId} within ${timeoutMs}ms`);
}

async function waitForStage(featureId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [feature] = await ctx.db.select().from(features).where(eq(features.id, featureId));
    if (feature?.currentStageId) return feature;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`card ${featureId} never left the backlog within ${timeoutMs}ms`);
}

/** The setting under test, which belongs to the project the issue lands in. */
async function setAutoStart(project: string, on: boolean): Promise<void> {
  await ctx.db.update(projects).set({ autoStartPipeline: on }).where(eq(projects.id, project));
}

test("an issue created in Linear enters the first stage when its project asked for it", async () => {
  await setAutoStart(projectId, true);
  // The whole inbound path: Linear's signed POST, the queue, the worker.
  const payload = JSON.stringify({
    type: "Issue",
    action: "create",
    data: {
      id: "issue-webhook",
      identifier: "INB-1",
      title: "Straight to work",
      url: "https://linear.app/bento/issue/INB-1",
      teamId: "team-inbound",
      projectId: "linear-inbound",
      state: { id: "s", name: "Backlog", type: "backlog" },
    },
    webhookTimestamp: Date.now(),
  });
  const res = await app.request("/api/webhooks/linear/local", {
    method: "POST",
    body: payload,
    headers: { "linear-signature": createHmac("sha256", webhookSecret).update(payload).digest("hex") },
  });
  assert.equal(res.status, 200, await res.text());

  const imported = await cardFor("issue-webhook");
  const started = await waitForStage(imported.id);
  assert.equal(started.currentStageId, firstStageId, "the card must be on the first stage");
  assert.equal(started.status, "active");
  assert.ok(started.branchName, "a card that left the backlog has a branch");

  const [move] = await ctx.db
    .select()
    .from(featureEvents)
    .where(eq(featureEvents.featureId, imported.id));
  assert.equal(move?.kind, "stage_moved");
  assert.equal(move?.fromStageId, null, "the card came from the backlog");
  assert.equal(move?.toStageId, firstStageId);
  // Its own trigger, so "started by Linear" is answerable in the history
  // rather than indistinguishable from a gate that never ran.
  assert.equal(move?.trigger, "linear_auto");
});

test("with the setting off the same issue waits in the backlog", async () => {
  await setAutoStart(projectId, false);
  await handleLinearInbound(ctx, {
    organizationId: null,
    action: "create",
    issue: issueCreated("quiet", "Waits for a person"),
  });

  const card = await cardFor("quiet");
  assert.equal(card.status, "backlog");
  assert.equal(card.currentStageId, null);
  const events = await ctx.db.select().from(featureEvents).where(eq(featureEvents.featureId, card.id));
  assert.equal(events.length, 0, "nothing moved, so nothing is logged");
});

test("each project decides for itself, so one starts while the other waits", async () => {
  // The reason the setting is per project: one team's intake is triaged
  // by a person, another's is meant to be picked up like a CI job. Two
  // followed Linear projects, one setting each, one webhook shape.
  const eager = await setupProject(ctx.userId, "Eager", null);
  const patient = await setupProject(ctx.userId, "Patient", null);
  await setAutoStart(eager, true);
  await setAutoStart(patient, false);
  try {
    for (const [id, team] of [
      ["eager-issue", "team-eager"],
      ["patient-issue", "team-patient"],
    ] as const) {
      await handleLinearInbound(ctx, {
        organizationId: null,
        action: "create",
        issue: issueCreated(id, `Filed in ${team}`, team),
      });
    }

    const started = await cardFor("eager-issue");
    assert.equal(started.projectId, eager);
    assert.ok((await waitForStage(started.id)).currentStageId, "the eager project's card moves");

    const waiting = await cardFor("patient-issue");
    assert.equal(waiting.projectId, patient);
    assert.equal(waiting.currentStageId, null, "the other project's card stays put");
    assert.equal(waiting.status, "backlog");
  } finally {
    await setAutoStart(eager, false);
  }
});

test("an issue labeled long after it was filed is imported without starting", async () => {
  await setAutoStart(projectId, true);
  try {
    // The bento label on an existing issue arrives as an update. It is a
    // person reaching for a ticket, not a ticket being created, so it
    // lands in the backlog for that person to advance.
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "update",
      issue: { ...issueCreated("labeled", "Labeled later"), labels: [{ id: "l1", name: "bento" }] },
    });

    const card = await cardFor("labeled");
    assert.equal(card.status, "backlog");
    assert.equal(card.currentStageId, null);
  } finally {
    await setAutoStart(projectId, false);
  }
});

test("the backlog sweep imports without starting anything", async () => {
  await setAutoStart(projectId, true);
  backlogIssues.push({
    id: "issue-old",
    identifier: "INB-9",
    title: "Filed months ago",
    url: "https://linear.app/bento/issue/INB-9",
  });
  try {
    const imported = await syncLinearBacklog(ctx, null);
    assert.equal(imported, 1);
    const card = await cardFor("issue-old");
    assert.equal(
      card.currentStageId,
      null,
      "a sweep can import a whole backlog at once; none of it may start an agent",
    );
    assert.equal(card.status, "backlog");
  } finally {
    backlogIssues.length = 0;
    await setAutoStart(projectId, false);
  }
});

test("an issue created with the bento label starts too, in the default project", async () => {
  // The label is the other way in, and an issue that carries it from the
  // moment it is filed is as new as one in a mapped team. Anything else
  // would make the setting depend on which door the issue came through.
  const labelProject = await setupProject(ctx.userId, "Labeled", null);
  await setAutoStart(labelProject, true);
  await ctx.db.update(linearConnections).set({ defaultProjectId: labelProject });
  try {
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: {
        ...issueCreated("tagged", "Filed with the label", "team-nowhere"),
        projectId: null,
        labels: [{ id: "l1", name: "bento" }],
      },
    });

    const card = await cardFor("tagged");
    assert.equal(card.projectId, labelProject);
    const started = await waitForStage(card.id);
    assert.equal(started.status, "active");
  } finally {
    await setAutoStart(labelProject, false);
    await ctx.db.update(linearConnections).set({ defaultProjectId: null });
  }
});

test("a plan with no room for another live card leaves the import in the backlog", async () => {
  await ctx.db.insert(organization).values({ id: "org-full", name: "Full", slug: "full" });
  const orgProject = await setupProject(ctx.userId, "Full", "org-full");
  await setAutoStart(orgProject, true);
  await ctx.db.insert(linearConnections).values({
    ownerId: ctx.userId,
    organizationId: "org-full",
    encryptedApiKey: ctx.secretBox.encrypt("lin_api_test"),
  });
  ctx.entitlements = {
    async canAddMember() {
      return null;
    },
    async canActivateFeature() {
      return { reason: "your plan allows 3 live features" };
    },
  };
  try {
    await handleLinearInbound(ctx, {
      organizationId: "org-full",
      action: "create",
      issue: issueCreated("capped", "No room", "team-full"),
    });

    const card = await cardFor("capped");
    assert.equal(card.projectId, orgProject);
    assert.equal(card.status, "backlog", "the import stays, the pipeline does not start");
    assert.equal(card.currentStageId, null);
  } finally {
    delete ctx.entitlements;
  }
});

/** The source under test: the Linear team and project a Bento project follows. */
async function followLinear(project: string, teamId: string | null, linearProjectId: string | null) {
  await ctx.db
    .update(projects)
    .set({ linearImportTeamId: teamId, linearImportProjectId: linearProjectId })
    .where(eq(projects.id, project));
}

async function linkFor(linearIssueId: string) {
  const [link] = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.linearIssueId, linearIssueId));
  return link;
}

test("only issues in the followed Linear project become cards, including ones moved in later", async () => {
  const follower = await setupProject(ctx.userId, "Follower", null);
  await setAutoStart(follower, true);
  try {
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: issueCreated("in-project", "Filed in the project", "team-follower"),
    });
    const card = await cardFor("in-project");
    assert.equal(card.projectId, follower);
    assert.ok((await waitForStage(card.id)).currentStageId, "a new issue starts like any other arrival");

    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: { ...issueCreated("elsewhere", "Another Linear project", "team-follower"), projectId: "linear-q4" },
    });
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: { ...issueCreated("no-project", "In no Linear project", "team-follower"), projectId: null },
    });
    assert.equal(await linkFor("elsewhere"), undefined, "the rest of the team stays in Linear");
    assert.equal(await linkFor("no-project"), undefined);

    // Moved into the followed project later: an update, imported, not started.
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "update",
      issue: issueCreated("moved-in", "Moved into the project", "team-follower"),
    });
    const moved = await cardFor("moved-in");
    assert.equal(moved.projectId, follower);
    assert.equal(moved.currentStageId, null);
  } finally {
    await setAutoStart(follower, false);
  }
});

test("a mapped team imports nothing on its own", async () => {
  // Mappings still say which team a project files issues in, and where a
  // labeled issue lands. A whole team's intake is never imported.
  const mapped = await setupProject(ctx.userId, "Mapped", null);
  await ctx.db.insert(linearTeamMappings).values({
    linearTeamId: "team-mapped-only",
    linearTeamKey: "MAP",
    linearTeamName: "Mapped only",
    projectId: mapped,
  });
  await handleLinearInbound(ctx, {
    organizationId: null,
    action: "create",
    issue: { ...issueCreated("mapped-new", "New in a mapped team", "team-mapped-only"), projectId: null },
  });
  assert.equal(await linkFor("mapped-new"), undefined);
});

test("a team picked without a Linear project imports nothing", async () => {
  const halfway = await setupProject(ctx.userId, "Halfway", null);
  await followLinear(halfway, "team-halfway", null);
  backlogIssues.push({
    id: "halfway-open",
    identifier: "HLF-1",
    title: "Open in the team",
    url: "https://linear.app/x/HLF-1",
    teamId: "team-halfway",
    projectId: "linear-anything",
  });
  try {
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: { ...issueCreated("halfway-new", "New in the team", "team-halfway"), projectId: "linear-anything" },
    });
    await syncLinearBacklog(ctx, null);
    assert.equal(await linkFor("halfway-new"), undefined);
    assert.equal(await linkFor("halfway-open"), undefined);
  } finally {
    backlogIssues.length = 0;
  }
});

test("the sweep brings in only the followed Linear project's open issues", async () => {
  const swept = await setupProject(ctx.userId, "Swept", null);
  backlogIssues.push(
    { id: "swept-in", identifier: "SWP-1", title: "In the project", url: "https://linear.app/x/SWP-1", teamId: "team-swept", projectId: "linear-swept" },
    { id: "swept-out", identifier: "SWP-2", title: "Elsewhere", url: "https://linear.app/x/SWP-2", teamId: "team-swept", projectId: "linear-other" },
  );
  try {
    await syncLinearBacklog(ctx, null);
    assert.equal((await cardFor("swept-in")).projectId, swept);
    assert.equal(await linkFor("swept-out"), undefined);
  } finally {
    backlogIssues.length = 0;
  }
});

test("two organizations following the same Linear project each import only their own events", async () => {
  await ctx.db.insert(organization).values([
    { id: "org-a", name: "A", slug: "a" },
    { id: "org-b", name: "B", slug: "b" },
  ]);
  const projectA = await setupProject(ctx.userId, "Shared", "org-a");
  const projectB = await setupProject(ctx.userId, "Shared", "org-b");
  for (const organizationId of ["org-a", "org-b"]) {
    await ctx.db.insert(linearConnections).values({
      ownerId: ctx.userId,
      organizationId,
      encryptedApiKey: ctx.secretBox.encrypt("lin_api_test"),
    });
  }
  await handleLinearInbound(ctx, {
    organizationId: "org-a",
    action: "create",
    issue: issueCreated("shared-a", "Filed in A's workspace", "team-shared"),
  });
  const card = await cardFor("shared-a");
  assert.equal(card.projectId, projectA);
  assert.notEqual(card.projectId, projectB);
  const links = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.linearIssueId, "shared-a"));
  assert.equal(links.length, 1, "the other organization's project gets nothing");
  assert.equal(links[0]!.organizationId, "org-a");
});

test("a new issue in Triage is imported and starts like any other", async () => {
  const triaged = await setupProject(ctx.userId, "Triaged", null);
  await setAutoStart(triaged, true);
  try {
    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: { ...issueCreated("in-triage", "Waiting in Triage", "team-triaged"), state: { id: "t", name: "Triage", type: "triage" } },
    });
    const card = await cardFor("in-triage");
    assert.equal(card.projectId, triaged);
    assert.ok((await waitForStage(card.id)).currentStageId);

    await handleLinearInbound(ctx, {
      organizationId: null,
      action: "create",
      issue: { ...issueCreated("started", "Already in progress", "team-triaged"), state: { id: "p", name: "In Progress", type: "started" } },
    });
    assert.equal(await linkFor("started"), undefined, "work already under way in Linear stays there");
  } finally {
    await setAutoStart(triaged, false);
  }
});
