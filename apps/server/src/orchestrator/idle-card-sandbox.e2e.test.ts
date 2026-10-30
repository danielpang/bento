import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { eq } from "drizzle-orm";
import { agentProfiles, agentRuns, createDb, createPool, features, repositories, runMigrations, sandboxes, type Db } from "@bento/db";
import { WorktreeManager, type ExecChunk, type SandboxDriver } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { EventBus } from "../events.js";
import { loadEnv } from "../env.js";
import { singleDriver } from "./sandbox-driver.js";
import {
  CARD_SANDBOX_IDLE_MS,
  IDLE_WORK_COMMIT_MESSAGE,
  reapIdleCardSandbox,
  reapIdleCardSandboxes,
  type IdleCardPushOptions,
} from "./idle-card-sandbox.js";
import { remoteBranchBundles } from "./swarm/remote-branches.js";

/**
 * A card left idle gives its sandbox back, and nothing on it is lost.
 *
 * Against a bare repository on disk standing in for GitHub, and a
 * directory standing in for a clone machine's checkout: the driver
 * runs its exec in that directory and exports from it, the way a
 * sprite or a Modal box does inside itself.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "idle_card_sandbox_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);
const PROJECT = "11111111-1111-1111-1111-111111111111";
const PIPELINE = "33333333-3333-3333-3333-333333333333";
const STAGE = "44444444-4444-4444-4444-444444444444";
const REPO_URL = "https://github.com/acme/app";
const DAY = 24 * 60 * 60 * 1000;

const exec = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: "Agent", GIT_AUTHOR_EMAIL: "agent@localhost", GIT_COMMITTER_NAME: "Agent", GIT_COMMITTER_EMAIL: "agent@localhost" };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env: { ...process.env, ...IDENTITY } });
  return stdout.trim();
}

let pool: ReturnType<typeof createPool>;
let db: Db;
let ctx: AppContext;
let dataDir: string;
let remotePath: string;
let profileId: string;

const publisher = {
  async pushToken() {
    return "unused: the remote is a directory";
  },
} as unknown as NonNullable<IdleCardPushOptions["publisher"]>;
const push = { publisher, remoteUrl: () => remotePath };
const offline = {
  publisher: { async pushToken() { throw new Error("GitHub is down"); } } as unknown as typeof publisher,
  remoteUrl: () => remotePath,
};

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
  await pool.query(`insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`, [PROJECT]);
  await pool.query(`insert into pipelines (id,project_id,name,is_default) values ($1,$2,'Default',true)`, [PIPELINE, PROJECT]);
  await pool.query(`insert into stages (id,pipeline_id,position,name,slug) values ($1,$2,0,'Implementation','implementation')`, [STAGE, PIPELINE]);
  const [profile] = await db.insert(agentProfiles).values({ ownerId: "u1", name: "Agent", cli: "fake", model: "fake-1" }).returning();
  profileId = profile!.id;

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-idle-card-e2e-"));
  remotePath = path.join(dataDir, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remotePath]);
  const source = path.join(dataDir, "source");
  await exec("git", ["init", "--quiet", "-b", "main", source]);
  await writeFile(path.join(source, "README.md"), "base\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "--quiet", "-m", "base"]);
  await git(source, ["push", "--quiet", remotePath, "main"]);
  await pool.query(
    `insert into repositories (project_id,name,local_path,repo_url,default_branch,position) values ($1,'app',$2,$3,'main',0)`,
    [PROJECT, source, REPO_URL],
  );

  ctx = {
    env: loadEnv({ BENTO_MODE: "local", DATABASE_URL: testUrl } as NodeJS.ProcessEnv),
    db,
    pool,
    bus: new EventBus(),
    userId: "u1",
    worktrees: new WorktreeManager(dataDir),
    drivers: singleDriver({ provider: "docker", workspace: "host" } as unknown as SandboxDriver),
    boss: { send: async () => "job" },
  } as unknown as AppContext;
});

after(async () => {
  await pool?.end();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * A clone machine: its checkouts live under `workdir`, its exec runs
 * there, and it exports the way the real drivers do (HEAD over the
 * base). `exists` answers until it has been destroyed.
 */
function cloneMachine() {
  const destroyed: string[] = [];
  const driver = {
    provider: "modal",
    workspace: "clone",
    async exists(handle: { externalId: string }) {
      return !destroyed.includes(handle.externalId);
    },
    async destroy(handle: { externalId: string }) {
      destroyed.push(handle.externalId);
    },
    async *exec(handle: { workdir: string }, argv: string[]): AsyncIterable<ExecChunk> {
      try {
        const { stdout, stderr } = await exec(argv[0]!, argv.slice(1), { cwd: handle.workdir, env: { ...process.env, ...IDENTITY } });
        if (stdout) yield { kind: "stdout", data: stdout };
        if (stderr) yield { kind: "stderr", data: stderr };
        yield { kind: "exit", exitCode: 0 };
      } catch (err) {
        const failed = err as { stderr?: string; code?: number };
        yield { kind: "stderr", data: failed.stderr ?? String(err) };
        yield { kind: "exit", exitCode: typeof failed.code === "number" ? failed.code : 1 };
      }
    },
    async exportRepository(handle: { workdir: string }, name: string, base: string) {
      const checkout = path.join(handle.workdir, name);
      const head = await git(checkout, ["rev-parse", "HEAD"]);
      const baseSha = await git(checkout, ["merge-base", head, `origin/${base}`]);
      if (baseSha === head) return null;
      const file = path.join(dataDir, `export-${randomUUID()}.bundle`);
      await git(checkout, ["bundle", "create", file, "HEAD", `^${baseSha}`]);
      return { baseSha, headSha: head, data: await readFile(file) };
    },
  } as unknown as SandboxDriver;
  return { ctx: { ...ctx, drivers: singleDriver(driver) } as AppContext, destroyed };
}

/**
 * A card with a machine whose checkout holds a commit the agent made,
 * a stage write-up, and a file the agent never committed. Last touched
 * `idleFor` ago.
 */
async function idleCard(slug: string, idleFor: number) {
  const featureId = randomUUID();
  const branch = `bento/${slug}`;
  const then = new Date(Date.now() - idleFor);
  await db.insert(features).values({
    id: featureId,
    projectId: PROJECT,
    pipelineId: PIPELINE,
    title: slug,
    status: "active",
    branchName: branch,
    createdAt: then,
    updatedAt: then,
  });
  await db.insert(agentRuns).values({
    type: "pipeline",
    featureId,
    stageId: STAGE,
    agentProfileId: profileId,
    prompt: "do the work",
    status: "succeeded",
    queuedAt: then,
    endedAt: then,
  });
  const workdir = path.join(dataDir, `machine-${slug}`);
  await mkdir(workdir, { recursive: true });
  const checkout = path.join(workdir, "app");
  await exec("git", ["clone", "--quiet", remotePath, checkout]);
  await git(checkout, ["checkout", "--quiet", "-b", branch]);
  await writeFile(path.join(checkout, "feature.ts"), "export const done = true;\n");
  await mkdir(path.join(checkout, "docs", "bento"), { recursive: true });
  await writeFile(path.join(checkout, "docs", "bento", "plan.md"), "# Plan\n");
  await git(checkout, ["add", "."]);
  await git(checkout, ["commit", "--quiet", "-m", "the agent's work"]);
  await writeFile(path.join(checkout, "half-done.ts"), "// not committed yet\n");
  const [row] = await db
    .insert(sandboxes)
    .values({ projectId: PROJECT, featureId, provider: "modal", externalId: `box-${slug}`, status: "ready", workdir, lastUsedAt: then, updatedAt: then })
    .returning();
  return { featureId, branch, checkout, sandboxId: row!.id };
}

const remoteHas = async (branch: string) => (await git(remotePath, ["branch", "--list", branch])).length > 0;
const readSandbox = async (id: string) => (await db.select().from(sandboxes).where(eq(sandboxes.id, id)))[0]!;

test("an idle card's work, uncommitted files and stage notes included, reaches GitHub before its sandbox goes", async () => {
  const card = await idleCard("idle-saved", CARD_SANDBOX_IDLE_MS + DAY);
  const machine = cloneMachine();

  assert.equal(await reapIdleCardSandbox(machine.ctx, card.featureId, { push }), true);

  const pushed = await git(remotePath, ["rev-parse", `refs/heads/${card.branch}`]);
  assert.equal(await git(remotePath, ["log", "-1", "--format=%s", pushed]), IDLE_WORK_COMMIT_MESSAGE, "the leftover file was committed");
  const files = (await git(remotePath, ["ls-tree", "-r", "--name-only", pushed])).split("\n");
  for (const file of ["feature.ts", "half-done.ts", "docs/bento/plan.md"]) assert.ok(files.includes(file), `${file} is on GitHub`);
  assert.deepEqual(machine.destroyed, ["box-idle-saved"]);
  assert.equal((await readSandbox(card.sandboxId)).status, "destroyed");

  // What the next run's new machine is made from.
  const [feature] = await db.select().from(features).where(eq(features.id, card.featureId));
  assert.equal(feature!.pushedHeads[card.branch]?.[REPO_URL], pushed, "the push is the next push's lease");
  const [repo] = await db.select().from(repositories);
  const bundles = await remoteBranchBundles(
    machine.ctx,
    { organizationId: null, branch: card.branch, pushedHeads: feature!.pushedHeads[card.branch], repoRows: [repo!] },
    push,
  );
  assert.equal(bundles.get("app")?.headSha, pushed, "the next run restores exactly what was saved");
});

test("a card used within the last five days keeps its sandbox", async () => {
  const card = await idleCard("idle-recent", CARD_SANDBOX_IDLE_MS - DAY);
  const machine = cloneMachine();

  await reapIdleCardSandboxes(machine.ctx, { push });

  assert.equal(machine.destroyed.includes("box-idle-recent"), false);
  assert.equal((await readSandbox(card.sandboxId)).status, "ready");
  assert.equal(await remoteHas(card.branch), false, "and nothing was pushed");
});

test("an idle card whose branch cannot reach GitHub keeps its sandbox", async () => {
  const card = await idleCard("idle-offline", CARD_SANDBOX_IDLE_MS + DAY);
  const machine = cloneMachine();

  assert.equal(await reapIdleCardSandbox(machine.ctx, card.featureId, { push: offline }), false);

  assert.deepEqual(machine.destroyed, [], "the machine, the only copy of the work, is still there");
  assert.equal((await readSandbox(card.sandboxId)).status, "ready");
});

test("a card a run started on while it was being saved keeps its sandbox", async () => {
  const card = await idleCard("idle-raced", CARD_SANDBOX_IDLE_MS + DAY);
  const machine = cloneMachine();
  const racing = {
    publisher: {
      async pushToken() {
        await db.insert(agentRuns).values({ type: "pipeline", featureId: card.featureId, stageId: STAGE, agentProfileId: profileId, prompt: "again", status: "queued" });
        return "unused";
      },
    } as unknown as typeof publisher,
    remoteUrl: () => remotePath,
  };

  assert.equal(await reapIdleCardSandbox(machine.ctx, card.featureId, { push: racing }), false);
  assert.deepEqual(machine.destroyed, []);
});

test("an idle card on a host driver loses its container and keeps its checkout", async () => {
  const card = await idleCard("idle-host", CARD_SANDBOX_IDLE_MS + DAY);
  await db.update(sandboxes).set({ provider: "docker" }).where(eq(sandboxes.id, card.sandboxId));
  const destroyed: string[] = [];
  const host = {
    ...ctx,
    drivers: singleDriver({
      provider: "docker",
      workspace: "host",
      async destroy(handle: { externalId: string }) {
        destroyed.push(handle.externalId);
      },
      async exists() {
        return false;
      },
    } as unknown as SandboxDriver),
  } as AppContext;

  assert.equal(await reapIdleCardSandbox(host, card.featureId, { push: offline }), true, "nothing has to reach GitHub");
  assert.deepEqual(destroyed, ["box-idle-host"]);
  await stat(path.join(card.checkout, "half-done.ts"));
  assert.equal(await remoteHas(card.branch), false);
});

test("a finished card is left to the finished card reaper", async () => {
  const card = await idleCard("idle-done", CARD_SANDBOX_IDLE_MS + DAY);
  await db.update(features).set({ status: "done" }).where(eq(features.id, card.featureId));
  const machine = cloneMachine();

  await reapIdleCardSandboxes(machine.ctx, { push });
  assert.equal(machine.destroyed.includes("box-idle-done"), false);
  assert.equal(await remoteHas(card.branch), false);
  // The sweep did pick up the card GitHub was down for earlier, now that it is back.
  assert.ok(machine.destroyed.includes("box-idle-offline"));
});
