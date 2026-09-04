import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { asc, eq } from "drizzle-orm";
import {
  agentRuns,
  createDb,
  createPool,
  runArtifacts,
  runMigrations,
  swarmTasks,
  swarms,
  type Db,
} from "@bento/db";
import type { ExecChunk, SandboxHandle } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { captureRunArtifacts } from "./capture-artifacts.js";

/**
 * Capturing a swarm's artifacts, against a real database.
 *
 * The dedupe is a query, so this is where it has to be exercised: two
 * leaves of one swarm produce the same file, and both have to end up
 * on their own task. A stubbed database would answer whatever the test
 * decided the query means.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "capture_artifacts_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const HANDLE: SandboxHandle = { externalId: "sbx-1", provider: "docker", workdir: "/workspace" };
const FILE = "report.md";

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;

/**
 * A sandbox that holds one file under the artifacts directory, with
 * the content this run wrote. Portable shell in, canned answers out:
 * the find lists the file, the probe prints its size and its bytes.
 */
function driverWith(content: string) {
  const abs = `${HANDLE.workdir}/artifacts/${FILE}`;
  const chunks = (stdout: string, exitCode: number): AsyncIterable<ExecChunk> => ({
    async *[Symbol.asyncIterator]() {
      if (stdout) yield { kind: "stdout", data: stdout } as ExecChunk;
      yield { kind: "exit", exitCode } as ExecChunk;
    },
  });
  return {
    provider: "docker" as const,
    exec(_handle: SandboxHandle, argv: string[]) {
      const script = argv[argv.length - 1] ?? "";
      if (script.includes("find ")) return chunks(`${abs}\n`, 0);
      if (script.includes(abs)) {
        const bytes = Buffer.from(content, "utf8");
        return chunks(`${bytes.byteLength}\n${bytes.toString("base64")}\n`, 0);
      }
      // The stage write-up, which a swarm never has, and the cleanup.
      if (script.includes("[ -f ")) return chunks("", 3);
      return chunks("", 0);
    },
  };
}

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
  await pool.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`,
    [PROJECT],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'A','fake','fake-1')`,
    [PROFILE],
  );
  ctx = { db, pool } as unknown as AppContext;
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query("delete from swarms");
});

/** Captures one run's artifacts out of a sandbox holding `content`. */
async function captureFor(
  swarmId: string,
  taskId: string | null,
  runId: string,
  content: string,
): Promise<void> {
  await captureRunArtifacts({ ...ctx, driver: driverWith(content) } as unknown as AppContext, {
    runId,
    owner: { swarmId, swarmTaskId: taskId },
    organizationId: null,
    stageSlug: "leaf",
    stageName: "Leaf",
    handle: HANDLE,
    repositories: [{ name: "api", mountPath: "/workspace/api" }],
    say: async () => {},
  });
}

async function swarmWithTwoLeaves() {
  const [swarm] = await db
    .insert(swarms)
    .values({ projectId: PROJECT, slug: `s-${Math.random().toString(36).slice(2, 8)}`, title: "S", status: "running" })
    .returning();
  const [first] = await db.insert(swarmTasks).values({ swarmId: swarm!.id, title: "first" }).returning();
  const [second] = await db.insert(swarmTasks).values({ swarmId: swarm!.id, title: "second" }).returning();
  const run = async (taskId: string) =>
    (
      await db
        .insert(agentRuns)
        .values({
          type: "swarm",
          swarmId: swarm!.id,
          swarmTaskId: taskId,
          role: "worker",
          agentProfileId: PROFILE,
          prompt: "",
          status: "succeeded",
        })
        .returning()
    )[0]!;
  return { swarm: swarm!, first: first!, second: second!, run };
}

test("two leaves that produce the same file each keep their own copy", async () => {
  const { swarm, first, second, run } = await swarmWithTwoLeaves();
  const firstRun = await run(first.id);
  const secondRun = await run(second.id);

  await captureFor(swarm.id, first.id, firstRun.id, "# the same write up\n");
  await captureFor(swarm.id, second.id, secondRun.id, "# the same write up\n");

  const rows = await db
    .select()
    .from(runArtifacts)
    .where(eq(runArtifacts.swarmId, swarm.id))
    .orderBy(asc(runArtifacts.createdAt));
  assert.equal(rows.length, 2, "a sibling leaf's identical file is its own artifact, not a repeat");
  assert.deepEqual(
    rows.map((row) => row.swarmTaskId).sort(),
    [first.id, second.id].sort(),
    "and each is recorded under the task that produced it",
  );
});

test("the same leaf writing the same file twice records it once", async () => {
  const { swarm, first, run } = await swarmWithTwoLeaves();
  const firstRun = await run(first.id);
  const resumed = await run(first.id);

  await captureFor(swarm.id, first.id, firstRun.id, "# unchanged\n");
  await captureFor(swarm.id, first.id, resumed.id, "# unchanged\n");

  const rows = await db.select().from(runArtifacts).where(eq(runArtifacts.swarmTaskId, first.id));
  assert.equal(rows.length, 1, "a judge or a resume reading back the same file adds nothing");

  // Changed content is a new artifact, on the same leaf.
  const third = await run(first.id);
  await captureFor(swarm.id, first.id, third.id, "# changed\n");
  assert.equal((await db.select().from(runArtifacts).where(eq(runArtifacts.swarmTaskId, first.id))).length, 2);
});
