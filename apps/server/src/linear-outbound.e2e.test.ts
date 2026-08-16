import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import pg from "pg";
import {
  createDb,
  createPool,
  features,
  linearConnections,
  linearIssueLinks,
  linearTeamMappings,
  pipelines,
  projects,
  runMigrations,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { ensureLocalUser, type AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { registerLinearJobs } from "./orchestrator/linear-sync.js";

/**
 * The Bento to Linear direction, end to end against a real database and
 * the real queue: a card created through the route reaches the worker,
 * the worker files an issue, and the link it writes is what every later
 * transition rides on.
 *
 * Linear itself is the one stub, because there is no workspace to file
 * into. Everything on this side is the shipping code, which is the part
 * that has been wrong before: a green unit test for the resolver would
 * say nothing about whether the route enqueues, whether the worker is
 * registered, or whether the insert trigger tolerates a link row that
 * names no organization.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "linear_outbound_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;
let projectId: string;
let mappedProjectId: string;
const originalFetch = globalThis.fetch;

/** Every issueCreate input the server sent, in order. */
const filed: { teamId: string; title: string; description?: string; projectId?: string }[] = [];

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-linear-"));
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
    driver: new LocalProcessDriver(),
    worktrees: new WorktreeManager(dataDir),
    secretBox: new SecretBox("test-encryption-key-at-least-32-chars"),
    artifacts: new DiskArtifactStore(dataDir),
    running: new Map(),
    liveInputs: new Map(),
    userId,
  };
  await registerLinearJobs(ctx);
  app = createApp(ctx);

  globalThis.fetch = stubLinear();

  for (const name of ["Unmapped", "Mapped"]) {
    const [project] = await db
      .insert(projects)
      .values({ ownerId: userId, name })
      .returning({ id: projects.id });
    await db.insert(pipelines).values({ projectId: project!.id, name: "Default", isDefault: true });
    if (name === "Unmapped") projectId = project!.id;
    else mappedProjectId = project!.id;
  }

  await db.insert(linearTeamMappings).values({
    linearTeamId: "team-mapped",
    linearTeamKey: "MAP",
    linearTeamName: "Mapped",
    projectId: mappedProjectId,
  });

  await db.insert(linearConnections).values({
    ownerId: userId,
    organizationId: null,
    encryptedApiKey: ctx.secretBox.encrypt("lin_api_test"),
    createIssues: true,
    defaultTeamId: "team-default",
    defaultTeamKey: "DEF",
    defaultTeamName: "Default",
    defaultLinearProjectId: "linear-project-1",
    defaultLinearProjectName: "Q3",
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

/** Linear, reduced to the two calls this path makes. */
function stubLinear(): typeof fetch {
  let issueNumber = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, any>;
    };
    if (body.query.includes("IssueCreate")) {
      filed.push(body.variables!.input);
      issueNumber += 1;
      return new Response(
        JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: `issue-${issueNumber}`,
                identifier: `DEF-${issueNumber}`,
                url: `https://linear.app/bento/issue/DEF-${issueNumber}`,
              },
            },
          },
        }),
        { status: 200 },
      );
    }
    // The 15 minute sweep may land mid test; an empty page keeps it quiet.
    return new Response(
      JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

async function createCard(project: string, title: string): Promise<string> {
  const res = await app.request("/api/features", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project, title, description: "from the board" }),
  });
  const body = await res.text();
  assert.equal(res.status, 201, body);
  return (JSON.parse(body) as { id: string }).id;
}

async function waitForLink(featureId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [link] = await ctx.db
      .select()
      .from(linearIssueLinks)
      .where(eq(linearIssueLinks.featureId, featureId))
      .limit(1);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no Linear issue was filed for feature ${featureId} within ${timeoutMs}ms`);
}

test("a card created in Bento files a Linear issue and links it", async () => {
  const featureId = await createCard(projectId, "Ship the thing");
  const link = await waitForLink(featureId);

  assert.equal(link.linearIssueIdentifier, "DEF-1");
  assert.equal(link.linearIssueUrl, "https://linear.app/bento/issue/DEF-1");
  assert.equal(link.linearTeamId, "team-default");
  // Linear chose the state, so there is nothing for the echo check yet.
  assert.equal(link.lastOutboundStateType, null);

  const sent = filed.find((input) => input.title === "Ship the thing");
  assert.ok(sent, "the create mutation must carry the card's title");
  assert.equal(sent.teamId, "team-default");
  assert.equal(sent.projectId, "linear-project-1");
  assert.equal(sent.description, "from the board");
});

test("a card in a mapped project files into that team, without the default project", async () => {
  const featureId = await createCard(mappedProjectId, "Mapped work");
  const link = await waitForLink(featureId);
  assert.equal(link.linearTeamId, "team-mapped");

  const sent = filed.find((input) => input.title === "Mapped work");
  assert.ok(sent);
  assert.equal(sent.teamId, "team-mapped");
  assert.equal(sent.projectId, undefined, "a project belongs to the default team only");
});

test("turning issue creation off leaves the card Bento only", async () => {
  await ctx.db.update(linearConnections).set({ createIssues: false });
  const quiet = await createCard(projectId, "No issue please");

  // A card made after it is switched back on is the barrier: once its
  // issue exists, the queue has been past the point where the first
  // card's would have been filed.
  await ctx.db.update(linearConnections).set({ createIssues: true });
  const loud = await createCard(projectId, "Issue please");
  await waitForLink(loud);

  const [link] = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.featureId, quiet))
    .limit(1);
  assert.equal(link, undefined, "no issue may be filed while the setting is off");
  assert.equal(
    filed.some((input) => input.title === "No issue please"),
    false,
  );
});

test("an imported card is never filed a second time", async () => {
  // Stand in for an import: a feature that already has its link.
  const [feature] = await ctx.db
    .insert(features)
    .values({
      projectId,
      pipelineId: (
        await ctx.db
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(eq(pipelines.projectId, projectId))
          .limit(1)
      )[0]!.id,
      title: "Came from Linear",
    })
    .returning({ id: features.id });
  await ctx.db.insert(linearIssueLinks).values({
    featureId: feature!.id,
    linearIssueId: "issue-existing",
    linearIssueIdentifier: "DEF-99",
    linearIssueUrl: "https://linear.app/bento/issue/DEF-99",
    linearTeamId: "team-default",
  });

  const { handleLinearIssueCreate } = await import("./orchestrator/linear-sync.js");
  await handleLinearIssueCreate(ctx, { featureId: feature!.id });

  const links = await ctx.db
    .select()
    .from(linearIssueLinks)
    .where(eq(linearIssueLinks.featureId, feature!.id));
  assert.equal(links.length, 1);
  assert.equal(links[0]!.linearIssueId, "issue-existing");
  assert.equal(
    filed.some((input) => input.title === "Came from Linear"),
    false,
  );
});

test("the settings route stores a default team and project", async () => {
  // The picker route and the write it feeds, over the wire.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    if (body.query.includes("TeamProjects")) {
      return new Response(
        JSON.stringify({
          data: { team: { projects: { nodes: [{ id: "linear-project-2", name: "Q4" }] } } },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ data: { teams: { nodes: [{ id: "team-other", key: "OTH", name: "Other" }] } } }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const listed = await app.request("/api/linear/projects?teamId=team-other");
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), [{ id: "linear-project-2", name: "Q4" }]);

    const res = await app.request("/api/linear/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultTeamId: "team-other", defaultLinearProjectId: "linear-project-2" }),
    });
    const stored = await res.text();
    assert.equal(res.status, 200, stored);
    assert.deepEqual(JSON.parse(stored), {
      defaultProjectId: null,
      createIssues: true,
      defaultTeamId: "team-other",
      defaultTeamKey: "OTH",
      defaultTeamName: "Other",
      defaultLinearProjectId: "linear-project-2",
      defaultLinearProjectName: "Q4",
    });

    // A team Linear does not know must not be storable, and a project
    // from the old team must not survive the switch.
    const unknown = await app.request("/api/linear/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultTeamId: "team-nope" }),
    });
    assert.equal(unknown.status, 404);

    const cleared = await app.request("/api/linear/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultTeamId: null }),
    });
    assert.equal(cleared.status, 200);
    const [row] = await ctx.db
      .select()
      .from(linearConnections)
      .where(and(eq(linearConnections.ownerId, ctx.userId)))
      .limit(1);
    assert.equal(row!.defaultTeamId, null);
    assert.equal(row!.defaultLinearProjectId, null, "a project cannot outlive its team");
    assert.equal(row!.defaultLinearProjectName, null);
  } finally {
    globalThis.fetch = stubLinear();
  }
});
