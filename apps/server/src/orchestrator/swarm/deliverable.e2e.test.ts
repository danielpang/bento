import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { and, eq } from "drizzle-orm";
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
import { assembleSwarmDocument, SECTION_DIR } from "./deliverable.js";

/**
 * A document swarm's deliverable, against a real checkout.
 *
 * The exit criterion is that one assembled markdown file exists in two
 * places: on the swarm as an artifact the console can show, and
 * committed on the swarm's branch where a reviewer reads it. Both are
 * read back here from where they actually live, out of git and out of
 * Postgres, rather than off the return value.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "swarm_document_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const PROJECT = "11111111-1111-1111-1111-111111111111";
const PROFILE = "22222222-2222-2222-2222-222222222222";
const TEMPLATE = "33333333-3333-3333-3333-333333333333";

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env: { ...process.env, ...IDENTITY } });
  return stdout.trim();
}

let pool: ReturnType<typeof createPool>;
let db: Db;
let dataDir: string;
let repoPath: string;

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
  await pool.query(
    `insert into swarm_templates (id,owner_id,organization_id,name,planner_profile_id,worker_profile_id,max_workers,worker_isolation,deliverable)
     values ($1,'u1',null,'T',$2,$2,2,'worktree','document')`,
    [TEMPLATE, PROFILE],
  );

  dataDir = await mkdtemp(path.join(tmpdir(), "bento-document-e2e-"));
  repoPath = path.join(dataDir, "source");
  await exec("git", ["init", "--quiet", "-b", "main", repoPath]);
  await writeFile(path.join(repoPath, "README.md"), "a repository\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "--quiet", "-m", "base"]);
});

after(async () => {
  await pool?.end();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query("delete from swarms");
});

/**
 * A document swarm whose sections are already on its branch, which is
 * what the merge queue leaves behind: one file per leaf, each landed
 * from its own branch.
 */
async function documentSwarm(slug: string) {
  const [swarm] = await db
    .insert(swarms)
    .values({
      projectId: PROJECT,
      slug,
      title: "Migrating off the legacy queue",
      goal: "Write the case for moving, and what moving involves.",
      templateId: TEMPLATE,
      status: "done",
      branchName: `swarm/${slug}`,
      deliverable: "document",
    })
    .returning();

  const worktree = path.join(dataDir, `tree-${slug}`);
  await git(repoPath, ["branch", `swarm/${slug}`, "main"]);
  await git(repoPath, ["worktree", "add", "--quiet", worktree, `swarm/${slug}`]);

  const [why] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, title: "Why", nodeType: "plan", status: "done", position: 0 })
    .returning();
  const [cost] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, parentId: why!.id, title: "What it costs us today", status: "done", position: 0 })
    .returning();
  const [how] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, title: "How", nodeType: "plan", status: "done", position: 1 })
    .returning();
  const [steps] = await db
    .insert(swarmTasks)
    .values({ swarmId: swarm!.id, parentId: how!.id, title: "The migration itself", status: "done", position: 0 })
    .returning();

  // The sections, as their workers wrote and committed them.
  await mkdir(path.join(worktree, SECTION_DIR), { recursive: true });
  await writeFile(
    path.join(worktree, SECTION_DIR, `${cost!.id}.md`),
    "# What it costs\n\nThe queue drops messages under load.\n",
  );
  await writeFile(
    path.join(worktree, SECTION_DIR, `${steps!.id}.md`),
    "# Steps\n\nOne consumer at a time.\n",
  );
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "--quiet", "-m", "sections"]);

  const [run] = await db
    .insert(agentRuns)
    .values({
      type: "swarm",
      role: "planner",
      swarmId: swarm!.id,
      agentProfileId: PROFILE,
      prompt: "plan it",
      status: "succeeded",
    })
    .returning();

  return { swarm: swarm!, worktree, run: run!, tasks: { why: why!, cost: cost!, how: how!, steps: steps! } };
}

/* ---------------------------------------------------------------- */

test("a document swarm produces one assembled file, on the swarm and on the branch", async () => {
  const fx = await documentSwarm("queue");

  const assembled = await assembleSwarmDocument(db, {
    swarm: fx.swarm,
    worktreePath: fx.worktree,
    preamble: "# Overview\n\nThree parts: why, how, and what it costs.",
  });

  assert.ok(assembled, "a document swarm assembles one");
  assert.equal(assembled!.path, "docs/queue.md");
  assert.equal(assembled!.sections, 4, "two plan nodes and two leaves");
  assert.equal(assembled!.written, 2, "both leaves wrote their section");
  assert.equal(assembled!.committed, true);

  // On the branch, read back out of git rather than off disk: what a
  // reviewer gets is what was committed.
  const committed = await git(fx.worktree, ["show", `swarm/queue:docs/queue.md`]);
  assert.match(committed, /^# Migrating off the legacy queue/);
  assert.match(committed, /## Overview/, "the planner's design note is the overview");
  assert.match(committed, /## Why/);
  assert.match(committed, /### What it costs us today/, "a leaf sits under its plan node");
  assert.match(committed, /#### What it costs/, "and the leaf's own heading sits under that");
  assert.match(committed, /The queue drops messages under load\./);
  assert.match(committed, /One consumer at a time\./);

  // And on the swarm, as one artifact the console can show.
  const artifacts = await db
    .select()
    .from(runArtifacts)
    .where(and(eq(runArtifacts.swarmId, fx.swarm.id), eq(runArtifacts.path, "docs/queue.md")));
  assert.equal(artifacts.length, 1, "one artifact, not one per section");
  assert.equal(artifacts[0]!.type, "swarm");
  assert.equal(artifacts[0]!.kind, "markdown", "so it renders through the markdown path with raw HTML off");
  assert.equal(artifacts[0]!.mime, "text/markdown");
  assert.equal(artifacts[0]!.content, `${committed}\n`, "the artifact and the commit are the same document");
  assert.equal(artifacts[0]!.featureId, null, "it belongs to the swarm, not to a card");
});

test("a leaf that wrote no section file falls back to its report", async () => {
  /**
   * A worker that put its section in its report rather than in a file
   * has still done the work, and a document with a hole in it over a
   * filing mistake helps nobody.
   */
  const fx = await documentSwarm("fallback");
  await db
    .update(swarmTasks)
    .set({ report: "I could not write the file, but here is the section: the consumers are the hard part." })
    .where(eq(swarmTasks.id, fx.tasks.steps.id));
  await rm(path.join(fx.worktree, SECTION_DIR, `${fx.tasks.steps.id}.md`));
  await git(fx.worktree, ["commit", "--quiet", "-am", "drop a section"]);

  const assembled = await assembleSwarmDocument(db, { swarm: fx.swarm, worktreePath: fx.worktree });
  assert.ok(assembled);
  assert.match(assembled!.content, /the consumers are the hard part/);
  assert.equal(assembled!.written, 2);
});

test("a leaf with nothing at all gets its heading and a sentence saying so", async () => {
  const fx = await documentSwarm("gap");
  await db.update(swarmTasks).set({ status: "failed" }).where(eq(swarmTasks.id, fx.tasks.steps.id));
  await rm(path.join(fx.worktree, SECTION_DIR, `${fx.tasks.steps.id}.md`));
  await git(fx.worktree, ["commit", "--quiet", "-am", "drop a section"]);

  const assembled = await assembleSwarmDocument(db, { swarm: fx.swarm, worktreePath: fx.worktree });
  assert.ok(assembled);
  assert.match(assembled!.content, /### The migration itself/, "the plan's heading is still there");
  assert.match(assembled!.content, /This section is failed/);
  assert.equal(assembled!.written, 1);
});

test("a cancelled section is not a gap in the document, it is not in it", async () => {
  const fx = await documentSwarm("withdrawn");
  await db.update(swarmTasks).set({ status: "cancelled" }).where(eq(swarmTasks.id, fx.tasks.how.id));
  await db.update(swarmTasks).set({ status: "cancelled" }).where(eq(swarmTasks.id, fx.tasks.steps.id));

  const assembled = await assembleSwarmDocument(db, { swarm: fx.swarm, worktreePath: fx.worktree });
  assert.ok(assembled);
  assert.ok(!assembled!.content.includes("## How"), "a withdrawn part is not a hole");
  assert.ok(!assembled!.content.includes("The migration itself"));
  assert.equal(assembled!.sections, 2);
});

test("assembling twice commits once", async () => {
  /**
   * A publish is safe to run twice, which is what a redelivered job
   * is, so assembly has to be as well: a second identical document is
   * not a second commit.
   */
  const fx = await documentSwarm("twice");
  const first = await assembleSwarmDocument(db, { swarm: fx.swarm, worktreePath: fx.worktree });
  assert.equal(first?.committed, true);
  const second = await assembleSwarmDocument(db, { swarm: fx.swarm, worktreePath: fx.worktree });
  assert.equal(second?.committed, false, "nothing changed, so nothing was committed");
  assert.equal(second?.content, first?.content);

  // And one artifact row, not two. The console lists a swarm's
  // artifacts newest first, so a second copy would be the same file
  // named twice with nothing to tell a person them apart.
  const rows = await db
    .select({ id: runArtifacts.id })
    .from(runArtifacts)
    .where(and(eq(runArtifacts.swarmId, fx.swarm.id), eq(runArtifacts.path, first!.path)));
  assert.equal(rows.length, 1, "a redelivered publish rewrites the document rather than adding one");
});

test("a code swarm assembles nothing", async () => {
  const fx = await documentSwarm("code");
  await db.update(swarms).set({ deliverable: "code" }).where(eq(swarms.id, fx.swarm.id));
  const [asCode] = await db.select().from(swarms).where(eq(swarms.id, fx.swarm.id));
  assert.equal(await assembleSwarmDocument(db, { swarm: asCode!, worktreePath: fx.worktree }), null);
});
