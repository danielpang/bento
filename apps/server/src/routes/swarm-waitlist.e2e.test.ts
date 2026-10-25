import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import pg from "pg";
import { createDb, createPool, runMigrations, type Db } from "@bento/db";
import type { AppContext } from "../context.js";
import { loadEnv } from "../env.js";
import { LoggingMailer, type Mailer, type Message } from "../mail.js";
import { actorMiddleware } from "../middleware/actor.js";
import { forgetSwarmAccess } from "../swarm-access.js";
import { SWARM_WAITLIST_EMAIL, swarmWaitlistRoutes } from "./swarm-waitlist.js";

/**
 * Join waitlist, against a real database: one mail per person, the
 * request recorded so the console can say so, and nothing sent for
 * somebody who is already let in.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_waitlist_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let pool: ReturnType<typeof createPool>;
let db: Db;
const realFetch = globalThis.fetch;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = createPool(testUrl);
  db = createDb(pool);
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','Una','una@x.test')`);
  await pool.query(
    `insert into identity.account (id,account_id,provider_id,user_id,access_token) values ('a1','42','github','u1','gho_test')`,
  );
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://api.github.com/user");
    return new Response(JSON.stringify({ login: "una-codes" }), { status: 200 });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await pool?.end();
});

function recordingMailer(fail = false): Mailer & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    description: "recording",
    sent,
    async send(message) {
      if (fail) throw new Error("smtp refused");
      sent.push(message);
    },
  };
}

function hosted(letIn: string[]): AppContext {
  forgetSwarmAccess();
  return {
    env: loadEnv({ BENTO_MODE: "multi", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    userId: "u1",
    auth: { api: { getSession: async () => ({ user: { id: "u1" }, session: { activeOrganizationId: null } }) } },
    analytics: {
      capture: () => {},
      captureException: () => {},
      shutdown: async () => {},
      isFeatureEnabled: async (_flag: string, _userId: string, properties: Record<string, string>) =>
        letIn.includes(properties.email ?? ""),
    },
  } as unknown as AppContext;
}

async function join(ctx: AppContext, mailer: Mailer): Promise<number> {
  const app = new Hono().use("*", actorMiddleware(ctx)).route("/", swarmWaitlistRoutes(ctx, mailer));
  return (await app.request("/", { method: "POST" })).status;
}

async function requestedAt(): Promise<Date | null> {
  const { rows } = await pool.query(`select swarm_waitlist_requested_at as at from identity."user" where id = 'u1'`);
  return rows[0].at;
}

test("a failed mail leaves the person free to ask again", async () => {
  assert.equal(await join(hosted([]), recordingMailer(true)), 502);
  assert.equal(await requestedAt(), null);
});

test("joining mails the inbox once with the email and GitHub username, and is recorded", async () => {
  const mailer = recordingMailer();
  assert.equal(await join(hosted([]), mailer), 200);
  assert.equal(await join(hosted([]), mailer), 200, "asking again still answers yes");
  assert.equal(mailer.sent.length, 1, "but sends nothing the second time");
  assert.equal(mailer.sent[0]!.to, SWARM_WAITLIST_EMAIL);
  assert.match(mailer.sent[0]!.text, /una@x\.test/);
  assert.match(mailer.sent[0]!.text, /una-codes/);
  assert.ok(await requestedAt());
});

test("somebody already let in is not put on the waitlist", async () => {
  await pool.query(`update identity."user" set swarm_waitlist_requested_at = null where id = 'u1'`);
  const mailer = recordingMailer();
  assert.equal(await join(hosted(["una@x.test"]), mailer), 409);
  assert.equal(mailer.sent.length, 0);
});

test("a server that cannot send mail says so rather than pretending", async () => {
  assert.equal(await join(hosted([]), new LoggingMailer()), 503);
});
