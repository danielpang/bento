import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import pg from "pg";
import { createDb, createPool, runMigrations, type Db } from "@bento/db";
import type { AppContext, Entitlements } from "../../context.js";
import { loadEnv } from "../../env.js";
import { FeatureFlags } from "../../feature-flags.js";
import { actorMiddleware } from "../../middleware/actor.js";
import { requireSwarms } from "./gate.js";

/**
 * The swarm gate, against a real database and a real request.
 *
 * Two things are worth checking here rather than in a unit test. The
 * order of the two refusals: a person who is not a beta tester has to
 * get 404, because 402 would tell them the feature exists. And that
 * both gates collapse in local mode, which is the mode a laptop install
 * runs and the one where nothing may be gated at all: the flag is on
 * and no entitlements module is registered, so a check that reads the
 * plan has to answer "allowed" without one.
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
  await pool.query(`insert into identity.organization (id,name,slug) values ('org-a','A','org-a')`);
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

/** Flags with the allowlist forced on or off, without reaching PostHog. */
function flags(enabled: boolean): FeatureFlags {
  return new FeatureFlags(
    {
      evaluateFlags: async () => ({ isEnabled: () => enabled }),
      shutdown: async () => {},
    },
    false,
  );
}

function multiCtx(overrides: {
  featureFlags?: FeatureFlags;
  entitlements?: Entitlements;
}): AppContext {
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

function localCtx(overrides: { entitlements?: Entitlements } = {}): AppContext {
  return {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    userId: "local-user",
    // Local mode always answers yes, which is what createFeatureFlags
    // builds there.
    featureFlags: new FeatureFlags(null, true),
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

test("a beta tester on a plan that includes swarms is allowed", async () => {
  const answer = await ask(multiCtx({ featureFlags: flags(true), entitlements: allowingPlan }));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { allowed: true });
});

test("a non tester is told nothing, even on a plan that would refuse", async () => {
  // Both gates would fire. The flag has to win, or the 402 announces a
  // feature this person is not supposed to know about.
  const answer = await ask(multiCtx({ featureFlags: flags(false), entitlements: refusingPlan }));
  assert.equal(answer.status, 404, "a non tester must not be able to tell that swarms exist");
  assert.deepEqual(answer.body, { error: "not found" });
});

test("a tester whose plan does not include swarms gets PLAN_LIMIT", async () => {
  const answer = await ask(multiCtx({ featureFlags: flags(true), entitlements: refusingPlan }));
  assert.equal(answer.status, 402);
  const body = answer.body as { code: string; error: string; message: string };
  assert.equal(body.code, "PLAN_LIMIT");
  assert.match(body.error, /Business plan/);
  assert.equal(body.message, body.error, "both spellings carry the sentence a person reads");
});

test("multi mode without a billing module has no plan to refuse", async () => {
  // The open source install: the flag decides, and nothing else does.
  const answer = await ask(multiCtx({ featureFlags: flags(true) }));
  assert.equal(answer.status, 200);
});

test("local mode is allowed with no flags host and no entitlements", async () => {
  const answer = await ask(localCtx());
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { allowed: true });
});

test("local mode is still allowed if a module somehow refuses", async () => {
  // Nothing registers entitlements locally, so this is belt and braces:
  // there is no organization on a local request, and a plan check with
  // no organization has nobody to ask about.
  const answer = await ask(localCtx({ entitlements: refusingPlan }));
  assert.equal(answer.status, 200, "local mode has one user and no team to bill");
});
