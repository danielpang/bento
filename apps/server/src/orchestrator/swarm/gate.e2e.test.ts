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
 * order of the two refusals: a plan without swarms says so before the
 * hosted waitlist is asked about. And that local mode,
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
});

after(async () => {
  await pool?.end();
});

/** PostHog, answering the hosted swarms flag for the emails it lets in. */
function posthog(letIn: string[], seen: Record<string, string>[] = []) {
  return {
    capture: () => {},
    captureException: () => {},
    shutdown: async () => {},
    isFeatureEnabled: async (flag: string, _userId: string, properties: Record<string, string>) => {
      assert.equal(flag, HOSTED_SWARMS_FLAG);
      seen.push(properties);
      return letIn.includes(properties.email ?? "");
    },
  };
}

/** PostHog that never answers. */
const silentPosthog = {
  capture: () => {},
  captureException: () => {},
  shutdown: async () => {},
  isFeatureEnabled: () => new Promise<boolean | undefined>(() => {}),
};

function multiCtx(overrides: { entitlements?: Entitlements; analytics?: AppContext["analytics"] } = {}): AppContext {
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

test("somebody whose email is on the flag, on a plan that includes swarms, is allowed", async () => {
  const seen: Record<string, string>[] = [];
  const answer = await ask(multiCtx({ entitlements: allowingPlan, analytics: posthog(["u@x.test"], seen) }));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { allowed: true });
  assert.deepEqual(seen, [{ email: "u@x.test" }], "the flag is asked by email alone");
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

test("a plan without swarms says so before the waitlist is asked about", async () => {
  const seen: Record<string, string>[] = [];
  const answer = await ask(multiCtx({ entitlements: refusingPlan, analytics: posthog([], seen) }));
  assert.equal(answer.status, 402);
  const body = answer.body as { code: string; error: string; message: string };
  assert.equal(body.code, "PLAN_LIMIT");
  assert.match(body.error, /Business plan/);
  assert.equal(body.message, body.error, "both spellings carry the sentence a person reads");
  assert.deepEqual(seen, [], "PostHog is not asked for a team that cannot run swarms anyway");
});

test("PostHog that does not answer in time is the waitlist", async () => {
  const started = Date.now();
  const answer = await ask(multiCtx({ entitlements: allowingPlan, analytics: silentPosthog }));
  assert.equal(answer.status, 403);
  assert.ok(Date.now() - started < 5000, "the gate does not wait on PostHog for long");
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
