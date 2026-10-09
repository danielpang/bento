import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { eq } from "drizzle-orm";
import { agentRuns, createDb, createPool, runEvents, runMigrations, sandboxes, swarms, type Db } from "@bento/db";

/**
 * Migration 0054, run against rows: the provider each run from before
 * 0053 used, read from its transcript and its sandbox row, on the
 * hosted instance only. The migrations have already run on an empty
 * database here, so the file is run again on the rows below, which is
 * also what proves running it twice changes nothing it already decided.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "run_provider_backfill_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
/** The hosted instance's organization, whose row is what the migration is guarded on. */
const HOSTED_ORG = "LElYbC0PEXQqAvpIKqVUK89Wc6Naxivb";
/** Before 0053 shipped; the migration reads nothing queued after it. */
const EARLIER = new Date("2026-10-08T12:00:00Z");
const backfill = readFileSync(
  new URL("../../../packages/db/migrations/0054_backfill_agent_run_sandbox_provider.sql", import.meta.url),
  "utf8",
);

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
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
  await pool.query(`insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`, [
    PROJECT,
  ]);
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'A','fake','fake-1')`,
    [PROFILE],
  );
});

after(async () => {
  await pool?.end();
});

let swarmCount = 0;

/** A finished swarm run on a machine whose row names `rowProvider`, with these system lines. */
async function runOn(
  rowProvider: string | null,
  lines: string[],
  run: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<string> {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug: `backfill-${++swarmCount}`,
      title: "S",
      plannerProfileId: PROFILE,
      workerProfileId: PROFILE,
      workerIsolation: "sandbox",
      status: "running",
    })
    .returning();
  const [sandbox] = rowProvider
    ? await db
        .insert(sandboxes)
        .values({ projectId: PROJECT, swarmId: swarm!.id, provider: rowProvider, externalId: `bento-swarm-${swarm!.id}` })
        .returning()
    : [];
  const [row] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      swarmId: swarm!.id,
      role: "planner",
      agentProfileId: PROFILE,
      prompt: "",
      status: "succeeded",
      sandboxId: sandbox?.id ?? null,
      queuedAt: EARLIER,
      ...run,
    })
    .returning();
  let seq = 0;
  for (const text of lines) {
    await db.insert(runEvents).values({ runId: row!.id, seq: ++seq, type: "message", payload: { type: "message", role: "system", text } });
  }
  return row!.id;
}

async function providerOf(runId: string): Promise<string | null> {
  const [row] = await db.select({ provider: agentRuns.sandboxProvider }).from(agentRuns).where(eq(agentRuns.id, runId));
  return row!.provider;
}

test("anywhere but the hosted instance, nothing is filled", async () => {
  const modalLine = await runOn("modal", ["Starting a Modal sandbox"]);
  const sprite = await runOn("sprite", []);
  const docker = await runOn("docker", []);

  await pool.query(backfill);

  assert.equal(await providerOf(modalLine), null);
  assert.equal(await providerOf(sprite), null);
  assert.equal(await providerOf(docker), null, "a self-hosted database keeps its earlier runs as 0053 left them");
});

test("on the hosted instance, each earlier finished run takes the provider its transcript and row say", async () => {
  await pool.query(
    `insert into identity.organization (id,name,slug) values ($1,'Hosted','hosted') on conflict do nothing`,
    [HOSTED_ORG],
  );
  const modalLine = await runOn("modal", ["Starting a Modal sandbox", "Preparing repository app..."]);
  const reused = await runOn("modal", ["Starting a Modal sandbox", "Reusing the Modal sandbox (bento-swarm-x)."]);
  // A swarm's row rewritten to sprite after its Modal machine was made again.
  const rewrittenRow = await runOn("sprite", ["Starting a Modal sandbox"]);
  // Fly could not make the sprite, and "auto" made the machine on Modal.
  const fellBack = await runOn("modal", ["Failed to provision sandbox, retrying.", "Starting a Modal sandbox"]);
  const sprite = await runOn("sprite", ["Preparing repository app..."]);
  const docker = await runOn("docker", []);
  // The row says modal, but the Modal driver never spoke for this run:
  // the row was rewritten after it, and its own provider is not known.
  const unknown = await runOn("modal", ["Preparing repository app..."]);
  const noMachine = await runOn(null, ["Sandbox failed to provision, we're investigating the issue. Please try again later."], {
    status: "failed",
  });
  const inFlight = await runOn("sprite", [], { status: "running" });
  // Queued after 0053 shipped: it recorded its own provider, or had none.
  const afterShip = await runOn("sprite", ["Starting a Modal sandbox"], { queuedAt: new Date("2026-10-09T19:00:00Z") });
  const alreadyRecorded = await runOn("sprite", ["Starting a Modal sandbox"], { sandboxProvider: "sprite" });
  // A user line that quotes the Modal sentence is not the driver's.
  const quoted = await runOn("sprite", []);
  await db.insert(runEvents).values({
    runId: quoted,
    seq: 1,
    type: "message",
    payload: { type: "message", role: "user", text: "Starting a Modal sandbox" },
  });

  await pool.query(backfill);

  assert.equal(await providerOf(modalLine), "modal");
  assert.equal(await providerOf(reused), "modal");
  assert.equal(await providerOf(rewrittenRow), "modal", "the transcript wins over a row rewritten since");
  assert.equal(await providerOf(fellBack), "modal");
  assert.equal(await providerOf(sprite), "sprite");
  assert.equal(await providerOf(docker), "docker", "a self-hosted run keeps its own driver");
  assert.equal(await providerOf(unknown), null, "a provider that cannot be known is not guessed");
  assert.equal(await providerOf(noMachine), null, "a run that got no machine has no provider");
  assert.equal(await providerOf(inFlight), null, "a run still going records its own");
  assert.equal(await providerOf(afterShip), null, "nothing queued after 0053 shipped is read");
  assert.equal(await providerOf(alreadyRecorded), "sprite", "what a run recorded itself is never overwritten");
  assert.equal(await providerOf(quoted), "sprite", "only the driver's own system line counts");

  // Again: nothing it decided moves, and nothing it left gets filled.
  await pool.query(backfill);
  assert.equal(await providerOf(rewrittenRow), "modal");
  assert.equal(await providerOf(unknown), null);
});

test("migration 0054 is in the journal, after the column it fills", () => {
  const journal = readFileSync(new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8");
  const tags = (JSON.parse(journal) as { entries: { tag: string }[] }).entries.map((entry) => entry.tag);
  assert.ok(tags.indexOf("0054_backfill_agent_run_sandbox_provider") > tags.indexOf("0053_agent_run_sandbox_provider"));
});
