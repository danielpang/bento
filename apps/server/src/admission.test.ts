import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDb, createPool, invitation, organization, runMigrations, user } from "@bento/db";
import pg from "pg";
import { hasPendingOrganizationInvitation, normalizeEmail } from "./admission.js";

test("normalizeEmail trims and lowercases without folding plus aliases", () => {
  assert.equal(normalizeEmail("  Ada.Lovelace+beta@Example.COM "), "ada.lovelace+beta@example.com");
  assert.equal(normalizeEmail("already@ok.test"), "already@ok.test");
});

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "admission_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let db: ReturnType<typeof createDb>;

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);
  db = createDb(createPool(testUrl));
});

after(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.end();
});

test("hasPendingOrganizationInvitation matches normalized pending invites only", async () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  await db.insert(user).values({
    id: "user-1",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: "00000000-0000-0000-0000-000000000001",
    name: "Team",
    slug: "team-admission-test",
  });
  await db.insert(invitation).values({
    id: "inv-live",
    organizationId: "00000000-0000-0000-0000-000000000001",
    email: "  Teammate@Example.COM ",
    role: "member",
    status: "pending",
    expiresAt: future,
    inviterId: "user-1",
  });
  await db.insert(invitation).values({
    id: "inv-expired",
    organizationId: "00000000-0000-0000-0000-000000000001",
    email: "expired@example.com",
    role: "member",
    status: "pending",
    expiresAt: past,
    inviterId: "user-1",
  });

  assert.equal(await hasPendingOrganizationInvitation(db, "teammate@example.com"), true);
  assert.equal(await hasPendingOrganizationInvitation(db, "expired@example.com"), false);
  assert.equal(await hasPendingOrganizationInvitation(db, "nobody@example.com"), false);
});
