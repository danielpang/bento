import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * The two backfills in 0028, replayed against rows they have to move.
 *
 * Every other suite starts from an empty database, so a migration's
 * UPDATE runs over nothing and its assertion passes by having no rows
 * to disagree with. That is the state a backfill is least interesting
 * in: the whole point of one is the database somebody has been running
 * against for a while. So this suite stops one migration short, writes
 * the rows a real database would be holding, and only then applies the
 * migration under test.
 *
 * Files are read and applied here rather than through runMigrations,
 * because drizzle's migrator applies everything pending and there would
 * be no moment in between to seed.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "migration_backfill_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

/** The migration under test. Everything before it is the starting point. */
const UNDER_TEST = "0028_run_artifact_type";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

type JournalEntry = { idx: number; when: number; tag: string };

function journal(): JournalEntry[] {
  const file = path.join(migrationsFolder, "meta", "_journal.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { entries: JournalEntry[] }).entries;
}

/** One migration file's statements, split the way drizzle marks them. */
function statementsOf(tag: string): string[] {
  const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function apply(client: pg.Client, tag: string): Promise<void> {
  for (const statement of statementsOf(tag)) await client.query(statement);
}

let client: pg.Client;

const PROJECT = "aaaaaaaa-0000-0000-0000-000000000001";
const PROFILE = "aaaaaaaa-0000-0000-0000-000000000002";
const PIPELINE = "aaaaaaaa-0000-0000-0000-000000000003";
const STAGE = "aaaaaaaa-0000-0000-0000-000000000004";
const FEATURE = "aaaaaaaa-0000-0000-0000-000000000005";
const CARD_RUN = "aaaaaaaa-0000-0000-0000-000000000006";
const SWARM = "aaaaaaaa-0000-0000-0000-000000000007";
const SWARM_RUN = "aaaaaaaa-0000-0000-0000-000000000008";

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();

  client = new pg.Client({ connectionString: testUrl });
  await client.connect();

  const entries = journal();
  const upTo = entries.findIndex((entry) => entry.tag === UNDER_TEST);
  assert.ok(upTo > 0, `${UNDER_TEST} must be in the journal, after the migrations it builds on`);
  for (const entry of entries.slice(0, upTo)) await apply(client, entry.tag);

  // The rows a database that has been in use would be holding.
  await client.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
  await client.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch) values ($1,'u1',null,'P','main')`,
    [PROJECT],
  );
  await client.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values ($1,'u1',null,'A','fake','fake-1')`,
    [PROFILE],
  );
  await client.query(`insert into pipelines (id,project_id,name) values ($1,$2,'P')`, [PIPELINE, PROJECT]);
  await client.query(`insert into stages (id,pipeline_id,position,name,slug) values ($1,$2,0,'Design','design')`, [
    STAGE,
    PIPELINE,
  ]);
  await client.query(`insert into features (id,project_id,pipeline_id,title) values ($1,$2,$3,'Card')`, [
    FEATURE,
    PROJECT,
    PIPELINE,
  ]);
  await client.query(
    `insert into agent_runs (id,type,feature_id,stage_id,agent_profile_id,prompt) values ($1,'pipeline',$2,$3,$4,'work')`,
    [CARD_RUN, FEATURE, STAGE, PROFILE],
  );
  await client.query(
    `insert into swarms (id,project_id,slug,title,status) values ($1,$2,'s','S','running')`,
    [SWARM, PROJECT],
  );
  await client.query(
    `insert into agent_runs (id,type,swarm_id,role,agent_profile_id,prompt) values ($1,'swarm',$2,'planner',$3,'')`,
    [SWARM_RUN, SWARM, PROFILE],
  );
  // A node stuck and wanting nobody, a node wanting somebody, and a node
  // whose only account of itself is the word this migration removes.
  await client.query(
    `insert into swarm_tasks (swarm_id,title,status,attention) values
       ($1,'stuck and said twice','blocked','blocked'),
       ($1,'asking','blocked','question'),
       ($1,'running long','working','long_running')`,
    [SWARM],
  );
  await client.query(
    `insert into run_artifacts (run_id,feature_id,stage_slug,stage_name,path,kind,mime,size,content)
     values ($1,$2,'design','Design','docs/bento/design.md','markdown','text/markdown',5,'card.')`,
    [CARD_RUN, FEATURE],
  );
  await client.query(
    `insert into run_artifacts (run_id,swarm_id,stage_slug,stage_name,path,kind,mime,size,content)
     values ($1,$2,'plan','Plan','plan/design.md','markdown','text/markdown',6,'swarm.')`,
    [SWARM_RUN, SWARM],
  );

  await apply(client, UNDER_TEST);
});

after(async () => {
  await client?.end();
});

test("a task whose attention only repeated its status comes out with none", async () => {
  const { rows } = await client.query<{ title: string; status: string; attention: string | null }>(
    "select title, status, attention from swarm_tasks order by title",
  );
  assert.deepEqual(
    rows.map((row) => `${row.title}: ${row.status}/${row.attention}`),
    [
      "asking: blocked/question",
      "running long: working/long_running",
      "stuck and said twice: blocked/null",
    ],
    "only the row that said blocked twice changed, and it kept the status that already said it",
  );
});

test("an artifact that was only implicitly a card's now says so", async () => {
  const { rows } = await client.query<{ path: string; type: string }>(
    "select path, type from run_artifacts order by path",
  );
  assert.deepEqual(
    rows.map((row) => `${row.path}=${row.type}`),
    ["docs/bento/design.md=pipeline", "plan/design.md=swarm"],
    "each row's board is read off the ids it was already holding",
  );

  // The default exists for the length of the backfill and no longer, or
  // an insert that forgot its board would file itself as a card's.
  const { rows: column } = await client.query<{ column_default: string | null; is_nullable: string }>(
    `select column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'run_artifacts' and column_name = 'type'`,
  );
  assert.equal(column[0]?.column_default, null, "the default is dropped in the same migration that added it");
  assert.equal(column[0]?.is_nullable, "NO");

  await assert.rejects(
    client.query(
      `insert into run_artifacts (run_id,feature_id,stage_slug,stage_name,path,kind,mime,size,content)
       values ($1,$2,'design','Design','no-board.md','markdown','text/markdown',1,'x')`,
      [CARD_RUN, FEATURE],
    ),
    /type/,
    "and an insert that names no board is refused rather than guessed at",
  );
});
