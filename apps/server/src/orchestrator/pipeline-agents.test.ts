import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  createDb,
  createPool,
  agentProfiles,
  pipelines,
  projects,
  runMigrations,
  stages,
  type Db,
} from "@bento/db";
import pg from "pg";
import { ensureLocalUser } from "../context.js";
import { pipelineAgentBinaries } from "./pipeline-agents.js";

const baseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "pipeline_agents_test";
const testUrl = baseUrl.replace(/\/[^/]+$/, `/${testDbName}`);

let db: Db;
let pool: ReturnType<typeof createPool>;
let userId: string;

before(async () => {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = createPool(testUrl);
  db = createDb(pool);
  userId = await ensureLocalUser(db);
});

after(async () => {
  await pool.end();
});

async function profile(cli: typeof agentProfiles.$inferInsert.cli, name: string): Promise<string> {
  const [row] = await db.insert(agentProfiles).values({ ownerId: userId, name, cli, model: "m" }).returning();
  return row!.id;
}

/** A pipeline whose stages carry the given agents, in order. */
async function pipeline(
  stageAgents: (string | null)[],
  opts: { judgeOnFirstStage?: string } = {},
): Promise<string> {
  const [project] = await db.insert(projects).values({ ownerId: userId, name: "p", localPath: "/tmp" }).returning();
  const [row] = await db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "Default", isDefault: true })
    .returning();
  await db.insert(stages).values(
    stageAgents.map((agentId, position) => ({
      pipelineId: row!.id,
      position,
      name: `Stage ${position}`,
      slug: `stage-${position}`,
      defaultAgentProfileId: agentId,
      ...(position === 0 && opts.judgeOnFirstStage
        ? { gateType: "auto" as const, gateCriteria: [{ type: "agent_judge", agentProfileId: opts.judgeOnFirstStage }] }
        : {}),
    })),
  );
  return row!.id;
}

test("a pipeline asks for its own agents and nothing else", async () => {
  const claude = await profile("claude-code", "impl");
  const codex = await profile("codex", "review");
  const pipelineId = await pipeline([claude, codex]);

  assert.deepEqual(await pipelineAgentBinaries(db, { pipelineId, runCli: "claude-code" }), ["claude", "codex"]);
});

/**
 * The whole pipeline, not this stage. A card keeps one machine for its
 * life, so the later stages' agents are installed during the cold
 * provision the first stage is already paying for.
 */
test("a stage's agent is installed before the card reaches that stage", async () => {
  const claude = await profile("claude-code", "impl");
  const cursor = await profile("cursor", "qa");
  const pipelineId = await pipeline([claude, cursor]);

  // The run is the first stage's, and cursor's binary is in the set anyway.
  const binaries = await pipelineAgentBinaries(db, { pipelineId, runCli: "claude-code" });
  assert.deepEqual(binaries, ["claude", "cursor-agent"]);
});

/** A gate's judge is an agent, and no stage's default names it. */
test("a gate's judge is counted", async () => {
  const claude = await profile("claude-code", "impl");
  const judge = await profile("opencode", "judge");
  const pipelineId = await pipeline([claude], { judgeOnFirstStage: judge });

  assert.deepEqual(await pipelineAgentBinaries(db, { pipelineId, runCli: "claude-code" }), ["claude", "opencode"]);
});

/**
 * The case that makes narrowing safe. Someone points a stage at an
 * agent, or starts a run by hand with one, after the pipeline was read.
 * Whatever the stages say, the CLI this run is about to spawn is in the
 * set, so the provision ahead of it installs that CLI.
 */
test("the agent this run spawns is included even when no stage names it", async () => {
  const claude = await profile("claude-code", "impl");
  const pipelineId = await pipeline([claude]);

  assert.deepEqual(await pipelineAgentBinaries(db, { pipelineId, runCli: "pi" }), ["claude", "pi"]);
});

test("a pipeline with no agents still asks for the one this run spawns", async () => {
  const pipelineId = await pipeline([null, null]);
  assert.deepEqual(await pipelineAgentBinaries(db, { pipelineId, runCli: "codex" }), ["codex"]);
});

/**
 * The fake agent runs in process and spawns no binary, so a pipeline
 * built entirely from it asks for nothing. The script and the probe
 * both have to survive an empty set, which agent-toolchain.test.ts
 * pins down; this is the query that can produce one.
 */
test("the in-process test agent asks for no binary", async () => {
  const fake = await profile("fake", "fake");
  const pipelineId = await pipeline([fake]);
  assert.deepEqual(await pipelineAgentBinaries(db, { pipelineId, runCli: "fake" }), []);
});

/**
 * A stage carrying a criterion shape this version does not know must
 * not take the rest of the pipeline's agents down with it, the same way
 * the gate evaluator reads criteria.
 */
test("a criterion this version cannot parse costs the pipeline nothing", async () => {
  const claude = await profile("claude-code", "impl");
  const [project] = await db.insert(projects).values({ ownerId: userId, name: "p", localPath: "/tmp" }).returning();
  const [row] = await db
    .insert(pipelines)
    .values({ projectId: project!.id, name: "Default", isDefault: true })
    .returning();
  await db.insert(stages).values({
    pipelineId: row!.id,
    position: 0,
    name: "Stage",
    slug: "stage",
    defaultAgentProfileId: claude,
    gateCriteria: [{ type: "from_a_later_version", somethingElse: true }],
  });

  assert.deepEqual(await pipelineAgentBinaries(db, { pipelineId: row!.id, runCli: "claude-code" }), ["claude"]);
});
