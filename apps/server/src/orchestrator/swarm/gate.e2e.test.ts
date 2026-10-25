import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import pg from "pg";
import { createDb, createPool, runMigrations, type Db } from "@bento/db";
import type { AppContext, Entitlements } from "../../context.js";
import { loadEnv } from "../../env.js";
import { actorMiddleware } from "../../middleware/actor.js";
import { forgetSwarmAccess, HOSTED_SWARMS_FLAG } from "../../swarm-access.js";
import { requireSwarms } from "./gate.js";

/**
 * The swarm gate, against a real database and a real request.
 *
 * Two things are worth checking here rather than in a unit test. The
 * order of the two refusals: somebody on the hosted waitlist gets
 * SWARM_WAITLIST before any plan is asked about. And that local mode,
 * which registers no entitlements module and has no waitlist, answers
 * "allowed" whatever its beta flag says.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_gate_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let pool: ReturnType<typeof createPool>;
let db: Db;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = createPool(testUrl);
  db = createDb(pool);
  // The team allows beta; each test sets the person's own switch.
  await pool.query(`insert into identity.organization (id,name,slug,beta_features_allowed) values ('org-a','A','org-a',true)`);
  await pool.query(
    `insert into identity."user" (id,name,email) values ('u1','U','u@x.test'), ('local-user','L','local@bento.dev')`,
  );
  await pool.query(
    `insert into identity.member (id,organization_id,user_id,role) values ('m1','org-a','u1','owner')`,
  );
  await linkGitHub();
  // GitHub names the linked token's owner; nothing else is fetched here.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://api.github.com/user");
    return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
  }) as typeof fetch;
});

const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await pool?.end();
});

async function linkGitHub(): Promise<void> {
  await pool.query(
    `insert into identity.account (id,account_id,provider_id,user_id,access_token) values ('a1','42','github','u1','gho_test')`,
  );
}

/** PostHog, answering the hosted swarms flag for the emails and usernames it lets in. */
function posthog(letIn: string[], seen: Record<string, string>[] = []) {
  return {
    capture: () => {},
    captureException: () => {},
    shutdown: async () => {},
    isFeatureEnabled: async (flag: string, _userId: string, properties: Record<string, string>) => {
      assert.equal(flag, HOSTED_SWARMS_FLAG);
      seen.push(properties);
      return letIn.includes(properties.github_username ?? "") || letIn.includes(properties.email ?? "");
    },
  };
}

function multiCtx(overrides: { entitlements?: Entitlements; analytics?: ReturnType<typeof posthog> } = {}): AppContext {
  forgetSwarmAccess();
  return {
    env: loadEnv({ BENTO_MODE: "multi", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    userId: "u1",
    auth: {
      api: {
        getSession: async () => ({
          user: { id: "u1" },
          session: { activeOrganizationId: "org-a" },
        }),
      },
    },
    ...overrides,
  } as unknown as AppContext;
}

/** Local Bento, started with its beta flag on or off. */
function localCtx(beta: boolean, overrides: { entitlements?: Entitlements } = {}): AppContext {
  return {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl, BENTO_BETA_FEATURES: String(beta) } as NodeJS.ProcessEnv),
    db,
    userId: "local-user",
    ...overrides,
  } as unknown as AppContext;
}

/** Runs one request through the gate and reports what a route would send. */
async function ask(ctx: AppContext): Promise<{ status: number; body: unknown }> {
  const app = new Hono().use("*", actorMiddleware(ctx)).get("/", async (c) => {
    const refusal = await requireSwarms(ctx, c);
    if (refusal) return c.json(refusal.body, refusal.status);
    return c.json({ allowed: true });
  });
  const res = await app.request("/");
  return { status: res.status, body: await res.json() };
}

/** A plan that refuses, and one that does not. */
const refusingPlan = {
  canAddMember: async () => null,
  canActivateFeature: async () => null,
  canUseSwarms: async () => ({ reason: "Swarms are on the Business plan. Upgrade to start one." }),
} as unknown as Entitlements;

const allowingPlan = {
  canAddMember: async () => null,
  canActivateFeature: async () => null,
  canUseSwarms: async () => null,
} as unknown as Entitlements;

test("somebody PostHog let in, on a plan that includes swarms, is allowed", async () => {
  const seen: Record<string, string>[] = [];
  const answer = await ask(multiCtx({ entitlements: allowingPlan, analytics: posthog(["octocat"], seen) }));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { allowed: true });
  assert.deepEqual(seen, [{ email: "u@x.test", github_username: "octocat" }], "the flag is asked by email and GitHub username");
});

test("an email on the flag lets somebody in without a GitHub identity", async () => {
  await pool.query(`delete from identity.account where id = 'a1'`);
  try {
    const answer = await ask(multiCtx({ entitlements: allowingPlan, analytics: posthog(["u@x.test"]) }));
    assert.equal(answer.status, 200);
  } finally {
    await linkGitHub();
  }
});

test("turning beta features on does not get past the waitlist", async () => {
  await pool.query(`update identity."user" set beta_features = true where id = 'u1'`);
  try {
    const answer = await ask(multiCtx({ entitlements: allowingPlan, analytics: posthog([]) }));
    assert.equal(answer.status, 403);
    assert.equal((answer.body as { code: string }).code, "SWARM_WAITLIST");
  } finally {
    await pool.query(`update identity."user" set beta_features = false where id = 'u1'`);
  }
});

test("somebody not let in is waitlisted before any plan is asked about", async () => {
  const answer = await ask(multiCtx({ entitlements: refusingPlan, analytics: posthog([]) }));
  assert.equal(answer.status, 403);
  assert.equal((answer.body as { code: string }).code, "SWARM_WAITLIST");
});

test("somebody with no GitHub identity and no listed email is waitlisted", async () => {
  await pool.query(`delete from identity.account where id = 'a1'`);
  try {
    const answer = await ask(multiCtx({ entitlements: allowingPlan, analytics: posthog(["octocat"]) }));
    assert.equal(answer.status, 403);
  } finally {
    await linkGitHub();
  }
});

test("a person let in whose plan does not include swarms gets PLAN_LIMIT", async () => {
  const answer = await ask(multiCtx({ entitlements: refusingPlan, analytics: posthog(["octocat"]) }));
  assert.equal(answer.status, 402);
  const body = answer.body as { code: string; error: string; message: string };
  assert.equal(body.code, "PLAN_LIMIT");
  assert.match(body.error, /Business plan/);
  assert.equal(body.message, body.error, "both spellings carry the sentence a person reads");
});

test("multi mode without PostHog or a billing module is open", async () => {
  // Somebody's own install, on their own sandboxes: nothing to waitlist.
  const answer = await ask(multiCtx());
  assert.equal(answer.status, 200);
});

test("local mode is open whatever its beta flag says", async () => {
  assert.equal((await ask(localCtx(false))).status, 200);
  assert.equal((await ask(localCtx(true))).status, 200);
});

test("local mode is still allowed if a module somehow refuses", async () => {
  // Nothing registers entitlements locally, so this is belt and braces:
  // there is no organization on a local request, and a plan check with
  // no organization has nobody to ask about.
  const answer = await ask(localCtx(true, { entitlements: refusingPlan }));
  assert.equal(answer.status, 200, "local mode has one user and no team to bill");
});
