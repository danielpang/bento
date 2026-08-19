import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import pg from "pg";
import {
  createDb,
  createPool,
  features,
  pipelines,
  projects,
  runMigrations,
  slackConnections,
  slackPendingMentions,
  slackThreadLinks,
  slackUserSettings,
  stages,
  agentProfiles,
  agentRuns,
  runEvents,
  runArtifacts,
  gateChecks,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { DiskArtifactStore } from "../artifact-store.js";
import { SecretBox } from "../secrets.js";
import { ensureLocalUser, LOCAL_USER_ID, type AppContext } from "../context.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { handleSlackInbound } from "./slack-sync.js";
import { handleSlackNotify, queueSlackNotify } from "./slack-notify.js";

/**
 * Slack inbound and notify against a real database. Slack itself is
 * the stub: the email match, the picker, and the approve path are the
 * parts that have been wrong before when only the webhook signature
 * was tested.
 */

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "slack_sync_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const TEAM = "TTEST";
const BOT = "UBOT";
const CHANNEL = "C1";
const MEMBER_SLACK = "UMEMBER";
const STRANGER_SLACK = "USTRANGER";

let ctx: AppContext;
let projectId: string;
let otherProjectId: string;
let stageId: string;
let nextStageId: string;
const originalFetch = globalThis.fetch;
const slackCalls: { method: string; body: Record<string, unknown> }[] = [];
const emails = new Map<string, string | null>([
  [MEMBER_SLACK, "LOCAL@BENTO.DEV"],
  [STRANGER_SLACK, "stranger@example.com"],
]);
let notifySent = 0;
let realSend: PgBoss["send"];

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-slack-"));
  const env = loadEnv({
    BENTO_MODE: "local",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_URL: "http://localhost:4400",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue("slack.notify");
  await boss.createQueue("gate.evaluate");
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
    draining: false,
    userId,
  };

  realSend = ctx.boss.send.bind(ctx.boss);
  ctx.boss.send = (async (name: string, data: object | null, options?: object) => {
    if (name === "slack.notify") notifySent += 1;
    return realSend(name, data as never, options as never);
  }) as PgBoss["send"];

  globalThis.fetch = stubSlack();

  const [project] = await db.insert(projects).values({ ownerId: userId, name: "Checkout" }).returning();
  const [other] = await db.insert(projects).values({ ownerId: userId, name: "Billing" }).returning();
  projectId = project!.id;
  otherProjectId = other!.id;
  const [pipeline] = await db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "Default", isDefault: true })
    .returning();
  await db.insert(pipelines).values({ projectId: other!.id, name: "Default", isDefault: true });
  const [design] = await db
    .insert(stages)
    .values({
      pipelineId: pipeline!.id,
      position: 0,
      name: "Design",
      slug: "design",
      gateType: "manual",
      gateCriteria: [{ type: "manual" }],
    })
    .returning();
  const [impl] = await db
    .insert(stages)
    .values({
      pipelineId: pipeline!.id,
      position: 1,
      name: "Implementation",
      slug: "implementation",
      gateType: "manual",
      gateCriteria: [{ type: "manual" }],
    })
    .returning();
  stageId = design!.id;
  nextStageId = impl!.id;

  await db.insert(slackConnections).values({
    ownerId: userId,
    organizationId: null,
    slackTeamId: TEAM,
    slackTeamName: "Acme",
    botUserId: BOT,
    encryptedBotToken: ctx.secretBox.encrypt("xoxb-test"),
    installedBy: userId,
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

function stubSlack(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = parsed.pathname.split("/").pop() ?? "";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : Object.fromEntries(parsed.searchParams.entries());
    slackCalls.push({ method, body });
    if (method === "users.info") {
      const userId = String(body.user ?? parsed.searchParams.get("user") ?? "");
      const email = emails.get(userId) ?? null;
      return new Response(
        JSON.stringify({
          ok: true,
          user: { id: userId, name: "person", profile: { email, real_name: "Person" } },
        }),
        { status: 200 },
      );
    }
    if (method === "chat.postMessage") {
      return new Response(
        JSON.stringify({ ok: true, channel: body.channel, ts: `${slackCalls.length}.0` }),
        { status: 200 },
      );
    }
    if (method === "chat.postEphemeral" || method === "chat.update") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: `unexpected ${method}` }), { status: 200 });
  }) as typeof fetch;
}

function mention(userId: string, text: string, ts = "10.0") {
  return handleSlackInbound(ctx, {
    kind: "mention",
    teamId: TEAM,
    channelId: CHANNEL,
    userId,
    text,
    ts,
    threadTs: ts,
  });
}

test("an unknown Slack user is refused and no card is created", async () => {
  slackCalls.length = 0;
  await mention(STRANGER_SLACK, `<@${BOT}> add dark mode`, "11.0");
  const posted = slackCalls.find((call) => call.method === "chat.postMessage");
  assert.ok(posted, "Bento must reply in the thread");
  assert.match(String(posted.body.text), /could not match your Slack email/i);
  const cards = await ctx.db.select().from(features);
  assert.equal(cards.length, 0);
});

test("email match is case-insensitive, remembers the Slack user id, and asks for a project when none is the default", async () => {
  slackCalls.length = 0;
  await mention(MEMBER_SLACK, `<@${BOT}> add dark mode`, "12.0");
  const [settings] = await ctx.db
    .select()
    .from(slackUserSettings)
    .where(eq(slackUserSettings.userId, LOCAL_USER_ID));
  assert.equal(settings?.slackUserId, MEMBER_SLACK);

  const pending = await ctx.db.select().from(slackPendingMentions);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.title, "add dark mode");
  const picker = slackCalls.find(
    (call) => call.method === "chat.postMessage" && String(call.body.text).includes("Which project"),
  );
  assert.ok(picker);
  const cards = await ctx.db.select().from(features);
  assert.equal(cards.length, 0);
});

test("picking a project creates the card and advances it off the backlog", async () => {
  const [pending] = await ctx.db.select().from(slackPendingMentions);
  assert.ok(pending);
  slackCalls.length = 0;
  await handleSlackInbound(ctx, {
    kind: "pick_project",
    teamId: TEAM,
    channelId: CHANNEL,
    userId: MEMBER_SLACK,
    pendingId: pending.id,
    projectId,
  });
  const cards = await ctx.db.select().from(features);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.title, "add dark mode");
  assert.equal(cards[0]?.currentStageId, stageId);
  assert.equal(cards[0]?.status, "active");
  const [link] = await ctx.db.select().from(slackThreadLinks);
  assert.equal(link?.featureId, cards[0]?.id);
  const leftover = await ctx.db.select().from(slackPendingMentions);
  assert.equal(leftover.length, 0);
});

test("a default project creates the card without a picker", async () => {
  await ctx.db
    .update(slackUserSettings)
    .set({ defaultProjectId: otherProjectId, updatedAt: new Date() })
    .where(eq(slackUserSettings.userId, LOCAL_USER_ID));
  slackCalls.length = 0;
  await mention(MEMBER_SLACK, `<@${BOT}> add receipts`, "13.0");
  const cards = await ctx.db.select().from(features).where(eq(features.title, "add receipts"));
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.projectId, otherProjectId);
  const picker = slackCalls.find((call) => String(call.body.text ?? "").includes("Which project"));
  assert.equal(picker, undefined);
});

test("a stranger cannot approve; a member can", async () => {
  const [card] = await ctx.db
    .insert(features)
    .values({
      projectId,
      pipelineId: (await ctx.db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.projectId, projectId)))[0]!.id,
      title: "Needs review",
      status: "gated",
      currentStageId: stageId,
    })
    .returning();
  await ctx.db.insert(slackThreadLinks).values({
    featureId: card!.id,
    slackTeamId: TEAM,
    slackChannelId: CHANNEL,
    slackThreadTs: "20.0",
    slackUserId: MEMBER_SLACK,
    reviewMessageTs: "20.1",
  });

  slackCalls.length = 0;
  await handleSlackInbound(ctx, {
    kind: "approve",
    teamId: TEAM,
    channelId: CHANNEL,
    userId: STRANGER_SLACK,
    featureId: card!.id,
    stageId,
    messageTs: "20.1",
  });
  const ephemeral = slackCalls.find((call) => call.method === "chat.postEphemeral");
  assert.ok(ephemeral);
  assert.match(String(ephemeral.body.text), /Bento account on this team/i);
  const stillGated = await ctx.db.select().from(features).where(eq(features.id, card!.id));
  assert.equal(stillGated[0]?.status, "gated");
  assert.equal(stillGated[0]?.currentStageId, stageId);

  slackCalls.length = 0;
  await handleSlackInbound(ctx, {
    kind: "approve",
    teamId: TEAM,
    channelId: CHANNEL,
    userId: MEMBER_SLACK,
    featureId: card!.id,
    stageId,
    messageTs: "20.1",
  });
  const after = await ctx.db.select().from(features).where(eq(features.id, card!.id));
  assert.equal(after[0]?.currentStageId, nextStageId);
  assert.equal(after[0]?.status, "active");
  const updated = slackCalls.find((call) => call.method === "chat.update");
  assert.ok(updated);
});

test("notify no-ops when the card was not created from Slack", async () => {
  const [pipeline] = await ctx.db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.projectId, projectId));
  const [card] = await ctx.db
    .insert(features)
    .values({ projectId, pipelineId: pipeline!.id, title: "Board only" })
    .returning();
  const before = notifySent;
  slackCalls.length = 0;
  await queueSlackNotify(ctx, { type: "created", featureId: card!.id });
  assert.equal(notifySent, before);
  assert.equal(slackCalls.length, 0);
});

test("a finished run posts its write-up, or the last assistant message if there is none", async () => {
  const { feature, run } = await slackLinkedRun("write-up card");
  await ctx.db.insert(runArtifacts).values({
    runId: run.id,
    featureId: feature.id,
    stageSlug: "design",
    stageName: "Design",
    path: "docs/bento/design.md",
    kind: "markdown",
    mime: "text/markdown",
    size: 12,
    content: "Ship the mockup.",
  });
  slackCalls.length = 0;
  await handleSlackNotify(ctx, { type: "run_finished", featureId: feature.id, runId: run.id });
  const posted = slackCalls.find((call) => call.method === "chat.postMessage");
  assert.ok(posted);
  assert.match(String(posted.body.text), /Design finished/);
  const blocks = JSON.stringify(posted.body.blocks);
  assert.match(blocks, /Ship the mockup/);

  const second = await slackLinkedRun("spoken card");
  await ctx.db.insert(runEvents).values({
    runId: second.run.id,
    seq: 1,
    type: "message",
    payload: { type: "message", role: "assistant", text: "Which palette should I use?" },
  });
  slackCalls.length = 0;
  await handleSlackNotify(ctx, { type: "run_finished", featureId: second.feature.id, runId: second.run.id });
  const spoken = slackCalls.find((call) => call.method === "chat.postMessage");
  assert.ok(spoken);
  assert.match(JSON.stringify(spoken.body.blocks), /Which palette should I use/);
});

test("a failed run posts the error; an auto-advance posts the move; a wait posts the reason", async () => {
  const failed = await slackLinkedRun("failed card", { status: "failed", error: "sandbox died" });
  slackCalls.length = 0;
  await handleSlackNotify(ctx, { type: "run_finished", featureId: failed.feature.id, runId: failed.run.id });
  const failPost = slackCalls.find((call) => call.method === "chat.postMessage");
  assert.ok(failPost);
  assert.match(String(failPost.body.text), /failed.*sandbox died/);

  slackCalls.length = 0;
  await handleSlackNotify(ctx, {
    type: "feature_event",
    featureId: failed.feature.id,
    kind: "stage_moved",
    trigger: "gate_auto",
    fromStageId: stageId,
    toStageId: nextStageId,
    fromStatus: null,
    toStatus: null,
  });
  const moved = slackCalls.find((call) => call.method === "chat.postMessage");
  assert.ok(moved);
  assert.match(String(moved.body.text), /passed and moved to \*Implementation\*/);

  await ctx.db.insert(gateChecks).values({
    featureId: failed.feature.id,
    stageId,
    criterion: { type: "agent_judge" },
    status: "failed",
    detail: { message: "The mockup is too sparse" },
  });
  slackCalls.length = 0;
  await handleSlackNotify(ctx, {
    type: "feature_event",
    featureId: failed.feature.id,
    kind: "status_changed",
    trigger: "gate_auto",
    fromStageId: null,
    toStageId: stageId,
    fromStatus: "active",
    toStatus: "gated",
  });
  const waiting = slackCalls.find((call) => call.method === "chat.postMessage");
  assert.ok(waiting);
  assert.match(String(waiting.body.text), /is waiting: The mockup is too sparse/);
});

async function slackLinkedRun(
  title: string,
  run: { status?: "succeeded" | "failed"; error?: string } = {},
) {
  const [pipeline] = await ctx.db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.projectId, projectId));
  const [feature] = await ctx.db
    .insert(features)
    .values({
      projectId,
      pipelineId: pipeline!.id,
      title,
      status: "active",
      currentStageId: stageId,
    })
    .returning();
  await ctx.db.insert(slackThreadLinks).values({
    featureId: feature!.id,
    slackTeamId: TEAM,
    slackChannelId: CHANNEL,
    slackThreadTs: `${Math.random()}`,
    slackUserId: MEMBER_SLACK,
  });
  const [profile] = await ctx.db
    .insert(agentProfiles)
    .values({
      ownerId: LOCAL_USER_ID,
      name: `${title} agent`,
      cli: "fake",
      model: "fake",
    })
    .returning();
  const [row] = await ctx.db
    .insert(agentRuns)
    .values({
      featureId: feature!.id,
      stageId,
      agentProfileId: profile!.id,
      prompt: "go",
      status: run.status ?? "succeeded",
      error: run.error ?? null,
    })
    .returning();
  return { feature: feature!, run: row! };
}
