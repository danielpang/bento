import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { runMigrations } from "@bento/db";

/**
 * Row-level security, checked against the database rather than through
 * the API.
 *
 * This exists because the first attempt at RLS passed every structural
 * check and isolated nothing: policies were enabled and forced, but the
 * connecting role was a superuser, and Postgres skips RLS entirely for
 * superusers and any role with BYPASSRLS. Only reading rows under a
 * foreign context catches that.
 */
const adminUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const testDbName = "rls_test";
const testUrl = adminUrl.replace(/\/[^/]+$/, `/${testDbName}`);

const TENANT_TABLES = [
  "projects",
  "repositories",
  "pipelines",
  "stages",
  "features",
  "feature_events",
  "feature_messages",
  "feature_pull_requests",
  "sandboxes",
  "agent_runs",
  "run_events",
  "run_artifacts",
  "gate_checks",
  "agent_profiles",
  "secrets",
  "github_installations",
  "linear_team_mappings",
  "linear_issue_links",
  "slack_connections",
  "slack_user_settings",
  "slack_thread_links",
  "slack_pending_mentions",
  "mcp_servers",
  "mcp_credentials",
  "mcp_run_grants",
  "swarm_templates",
  "swarms",
  "swarm_tasks",
  "swarm_task_events",
  "swarm_landings",
  "swarm_pull_requests",
  "swarm_messages",
];

let pool: pg.Pool;

/** Reads as a given organization, the way a request does. */
async function asOrg<T>(orgId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('role','bento_user',true), set_config('bento.org_id',$1,true)", [orgId]);
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDbName}`);
  await admin.end();
  await runMigrations(testUrl);

  pool = new pg.Pool({ connectionString: testUrl });
  // Two organizations, each with a project and a feature beneath it.
  await pool.query(`insert into identity.organization (id,name,slug) values
    ('org-a','A','org-a'), ('org-b','B','org-b')`);
  await pool.query(`insert into identity."user" (id,name,email) values ('u1','U','u@x.test')`);
  for (const [org, suffix] of [["org-a", "a"], ["org-b", "b"]] as const) {
    await pool.query(
      `insert into projects (id,owner_id,organization_id,name,default_branch)
       values ($1,'u1',$2,$3,'main')`,
      [`0000000${suffix === "a" ? 1 : 2}-0000-0000-0000-000000000000`, org, `project ${suffix}`],
    );
  }
});

after(async () => {
  await pool?.end();
});

test("policies are enabled AND forced on every tenant table", async () => {
  const { rows } = await pool.query(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relname = any($1)`,
    [TENANT_TABLES],
  );
  assert.equal(rows.length, TENANT_TABLES.length, "every tenant table must exist");
  for (const row of rows) {
    assert.ok(row.relrowsecurity, `${row.relname} has RLS disabled`);
    // Without FORCE, the owning role bypasses the policy and the whole
    // mechanism is decorative.
    assert.ok(row.relforcerowsecurity, `${row.relname} does not FORCE RLS, so its owner bypasses it`);
  }
});

test("the role requests use cannot bypass row-level security", async () => {
  const { rows } = await pool.query(
    `select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'bento_user'`,
  );
  assert.equal(rows.length, 1, "the bento_user role must exist");
  assert.equal(rows[0].rolcanlogin, false, "bento_user must be NOLOGIN");
  assert.equal(rows[0].rolsuper, false, "bento_user must not be a superuser");
  assert.equal(rows[0].rolbypassrls, false, "bento_user must not have BYPASSRLS");
});

test("tenant context uses only the Bento database names", async () => {
  const { rows } = await pool.query(
    `select proname from pg_proc
     where proname in ('bento_current_org', 'bento_inherit_org')
     order by proname`,
  );
  assert.deepEqual(rows.map((row) => row.proname), ["bento_current_org", "bento_inherit_org"]);
  const context = await asOrg("org-a", (client) =>
    client.query("select current_setting('bento.org_id', true) as organization_id"),
  );
  assert.equal(context.rows[0].organization_id, "org-a");
});

test("an organization sees only its own rows", async () => {
  const a = await asOrg("org-a", (c) => c.query("select name from projects"));
  const b = await asOrg("org-b", (c) => c.query("select name from projects"));
  assert.deepEqual(a.rows.map((r) => r.name), ["project a"]);
  assert.deepEqual(b.rows.map((r) => r.name), ["project b"]);
});

test("every tenant table returns nothing under a foreign context", async () => {
  await asOrg("org-nobody", async (client) => {
    for (const table of TENANT_TABLES) {
      const { rows } = await client.query(`select count(*)::int as n from ${table}`);
      assert.equal(rows[0].n, 0, `${table} leaked ${rows[0].n} row(s) to an unrelated organization`);
    }
  });
});

test("a query that forgets its WHERE clause still cannot cross organizations", async () => {
  // The point of RLS: correctness no longer depends on remembering to
  // filter. This is the query an IDOR bug would issue.
  const { rows } = await asOrg("org-a", (c) => c.query("select organization_id from projects"));
  assert.ok(rows.length > 0, "the caller's own rows must still be reachable");
  assert.ok(
    rows.every((r) => r.organization_id === "org-a"),
    "an unfiltered select must still be confined to the caller's organization",
  );
});

test("a row cannot be written into another organization", async () => {
  await assert.rejects(
    asOrg("org-a", (c) =>
      c.query(
        `insert into projects (owner_id,organization_id,name,default_branch)
         values ('u1','org-b','smuggled','main')`,
      ),
    ),
    /row-level security/,
    "the WITH CHECK clause must reject a write aimed at another organization",
  );
});

test("child inserts inherit their organization from the parent", async () => {
  const projectId = "00000001-0000-0000-0000-000000000000";
  const result = await asOrg("org-a", (client) =>
    client.query(
      `insert into repositories (project_id,name,local_path)
       values ($1,'inherited','/tmp/inherited')
       returning organization_id`,
      [projectId],
    ),
  );
  assert.equal(result.rows[0].organization_id, "org-a");
});

test("a message queued for a card belongs to that card's organization", async () => {
  // Messages carry what a person said to a card, so a leak here is a
  // leak of the conversation itself. The insert names no organization:
  // the trigger has to derive it from the feature.
  const projectA = "00000001-0000-0000-0000-000000000000";
  const pipelineId = "10000003-0000-0000-0000-000000000000";
  const featureId = "40000003-0000-0000-0000-000000000000";
  await pool.query(
    `insert into pipelines (id,project_id,organization_id,name) values ($1,$2,'org-a','messages')`,
    [pipelineId, projectA],
  );
  await pool.query(
    `insert into features (id,project_id,organization_id,pipeline_id,title)
     values ($1,$2,'org-a',$3,'Feature with messages')`,
    [featureId, projectA, pipelineId],
  );

  const inserted = await asOrg("org-a", (client) =>
    client.query(
      `insert into feature_messages (feature_id,text) values ($1,'ship it') returning organization_id`,
      [featureId],
    ),
  );
  assert.equal(inserted.rows[0].organization_id, "org-a");

  const foreign = await asOrg("org-b", (client) =>
    client.query("select count(*)::int as n from feature_messages"),
  );
  assert.equal(foreign.rows[0].n, 0, "another organization must not read a card's messages");
});

test("a run cannot reference another tenant's stage or agent", async () => {
  const projectA = "00000001-0000-0000-0000-000000000000";
  const projectB = "00000002-0000-0000-0000-000000000000";
  const pipelineA = "10000001-0000-0000-0000-000000000000";
  const pipelineB = "10000002-0000-0000-0000-000000000000";
  const stageA = "20000001-0000-0000-0000-000000000000";
  const stageB = "20000002-0000-0000-0000-000000000000";
  const profileA = "30000001-0000-0000-0000-000000000000";
  const profileB = "30000002-0000-0000-0000-000000000000";
  const featureA = "40000001-0000-0000-0000-000000000000";
  await pool.query(
    `insert into pipelines (id,project_id,organization_id,name) values
       ($1,$2,'org-a','A'), ($3,$4,'org-b','B')`,
    [pipelineA, projectA, pipelineB, projectB],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model) values
       ($1,'u1','org-a','A','fake','fake-1'), ($2,'u1','org-b','B','fake','fake-1')`,
    [profileA, profileB],
  );
  await pool.query(
    `insert into stages (id,pipeline_id,organization_id,position,name,slug) values
       ($1,$2,'org-a',0,'A','a'), ($3,$4,'org-b',0,'B','b')`,
    [stageA, pipelineA, stageB, pipelineB],
  );
  await pool.query(
    `insert into features (id,project_id,organization_id,pipeline_id,title,current_stage_id)
     values ($1,$2,'org-a',$3,'Feature A',$4)`,
    [featureA, projectA, pipelineA, stageA],
  );

  await asOrg("org-a", async (client) => {
    await client.query(
      `insert into agent_runs (feature_id,stage_id,agent_profile_id,prompt)
       values ($1,$2,$3,'valid')`,
      [featureA, stageA, profileA],
    );
    await assert.rejects(
      client.query(
        `insert into agent_runs (feature_id,stage_id,agent_profile_id,prompt)
         values ($1,$2,$3,'foreign')`,
        [featureA, stageB, profileB],
      ),
      /organization or pipeline boundary/,
    );
  });
});

test("run artifacts inherit their organization from the run", async () => {
  // Self-contained fixtures, so this test does not lean on rows another
  // test happened to leave behind.
  const projectA = "00000001-0000-0000-0000-000000000000";
  const pipeline = "10000009-0000-0000-0000-000000000000";
  const stage = "20000009-0000-0000-0000-000000000000";
  const profile = "30000009-0000-0000-0000-000000000000";
  const feature = "40000009-0000-0000-0000-000000000000";
  const run = "50000009-0000-0000-0000-000000000000";
  await pool.query(
    `insert into pipelines (id,project_id,organization_id,name) values ($1,$2,'org-a','Artifacts')`,
    [pipeline, projectA],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model)
     values ($1,'u1','org-a','Artifacts','fake','fake-1')`,
    [profile],
  );
  await pool.query(
    `insert into stages (id,pipeline_id,organization_id,position,name,slug)
     values ($1,$2,'org-a',0,'Design','design')`,
    [stage, pipeline],
  );
  await pool.query(
    `insert into features (id,project_id,organization_id,pipeline_id,title)
     values ($1,$2,'org-a',$3,'Artifact feature')`,
    [feature, projectA, pipeline],
  );
  await pool.query(
    `insert into agent_runs (id,feature_id,organization_id,stage_id,agent_profile_id,prompt)
     values ($1,$2,'org-a',$3,$4,'work')`,
    [run, feature, stage, profile],
  );

  const inherited = await asOrg("org-a", (client) =>
    client.query(
      `insert into run_artifacts (run_id,feature_id,stage_slug,stage_name,path,kind,mime,size,content)
       values ($1,$2,'design','Design','docs/bento/design.md','markdown','text/markdown',5,'hello')
       returning organization_id`,
      [run, feature],
    ),
  );
  assert.equal(inherited.rows[0].organization_id, "org-a");

  // Exactly one of the inline body and the store key, never both.
  await assert.rejects(
    pool.query(
      `insert into run_artifacts (run_id,feature_id,stage_slug,stage_name,path,kind,mime,size,content,storage_key)
       values ($1,$2,'design','Design','both.png','image','image/png',5,'x','a/key')`,
      [run, feature],
    ),
    /run_artifacts_content_or_key/,
  );
});

test("secret names are unique locally and within each organization", async () => {
  await pool.query(
    `insert into secrets (owner_id,organization_id,name,ciphertext)
     values ('u1',null,'LOCAL_KEY','one'),
            ('u1','org-a','ORG_KEY','one'),
            ('u1','org-b','ORG_KEY','two')`,
  );
  await assert.rejects(
    pool.query(
      `insert into secrets (owner_id,organization_id,name,ciphertext)
       values ('u1',null,'LOCAL_KEY','duplicate')`,
    ),
    /secrets_local_name_idx/,
  );
  await assert.rejects(
    pool.query(
      `insert into secrets (owner_id,organization_id,name,ciphertext)
       values ('u1','org-a','ORG_KEY','duplicate')`,
    ),
    /secrets_org_name_idx/,
  );
});

test("background workers keep the cross-organization access they need", async () => {
  // Workers do not switch roles, so one process can execute runs and
  // evaluate gates for every tenant.
  const { rows } = await pool.query("select count(*)::int as n from projects");
  assert.equal(rows[0].n, 2, "the worker role must see every organization's rows");
});

test("a Slack thread link inherits its organization from the card", async () => {
  const projectA = "00000001-0000-0000-0000-000000000000";
  const pipelineId = "1000000a-0000-0000-0000-000000000000";
  const featureId = "4000000a-0000-0000-0000-000000000000";
  await pool.query(
    `insert into pipelines (id,project_id,organization_id,name) values ($1,$2,'org-a','slack')`,
    [pipelineId, projectA],
  );
  await pool.query(
    `insert into features (id,project_id,organization_id,pipeline_id,title)
     values ($1,$2,'org-a',$3,'Slack card')`,
    [featureId, projectA, pipelineId],
  );

  const inserted = await asOrg("org-a", (client) =>
    client.query(
      `insert into slack_thread_links (feature_id,slack_team_id,slack_channel_id,slack_thread_ts,slack_user_id)
       values ($1,'T1','C1','1.0','U1') returning organization_id`,
      [featureId],
    ),
  );
  assert.equal(inserted.rows[0].organization_id, "org-a");

  const foreign = await asOrg("org-b", (client) =>
    client.query("select count(*)::int as n from slack_thread_links"),
  );
  assert.equal(foreign.rows[0].n, 0, "another organization must not read a Slack thread link");
});

test("MCP server slugs are unique locally and within each organization", async () => {
  await pool.query(
    `insert into mcp_servers (owner_id,organization_id,name,slug,url,auth_type)
     values ('u1',null,'Local','context7','https://a.test/mcp','none'),
            ('u1','org-a','A','context7','https://a.test/mcp','none'),
            ('u1','org-b','B','context7','https://a.test/mcp','none')`,
  );
  await assert.rejects(
    pool.query(
      `insert into mcp_servers (owner_id,organization_id,name,slug,url,auth_type)
       values ('u1',null,'Local dup','context7','https://a.test/mcp','none')`,
    ),
    /mcp_servers_local_slug_idx/,
  );
  await assert.rejects(
    pool.query(
      `insert into mcp_servers (owner_id,organization_id,name,slug,url,auth_type)
       values ('u1','org-a','A dup','context7','https://a.test/mcp','none')`,
    ),
    /mcp_servers_org_slug_idx/,
  );
});

test("a personal MCP server may share a slug with a team server, but not with the same member's own", async () => {
  // A member's personal server can reuse a team slug (the run pipeline
  // resolves that in the team's favor), and different members may each
  // have a personal server on the same slug.
  await pool.query(`insert into identity."user" (id,name,email) values ('u2','U2','u2@x.test')`);
  await pool.query(
    `insert into mcp_servers (owner_id,organization_id,user_id,name,slug,url,auth_type)
     values ('u1','org-a',null,'Team docs','docs','https://t.test/mcp','none'),
            ('u1','org-a','u1','My docs','docs','https://m.test/mcp','none'),
            ('u2','org-a','u2','U2 docs','docs','https://m2.test/mcp','none')`,
  );
  // But one member cannot have two personal servers on the same slug.
  await assert.rejects(
    pool.query(
      `insert into mcp_servers (owner_id,organization_id,user_id,name,slug,url,auth_type)
       values ('u1','org-a','u1','My docs 2','docs','https://m.test/mcp','none')`,
    ),
    /mcp_servers_org_user_slug_idx/,
  );
});

test("an MCP credential inherits its organization and stays unique per scope", async () => {
  const { rows: [server] } = await pool.query(
    `insert into mcp_servers (owner_id,organization_id,name,slug,url,auth_type)
     values ('u1','org-a','Notion','notion','https://n.test/mcp','oauth') returning id`,
  );

  // The org credential (user_id null) inherits the server's organization.
  // asOrg rolls back, so this checks the trigger and leaves no row.
  const inserted = await asOrg("org-a", (client) =>
    client.query(
      `insert into mcp_credentials (server_id,kind,encrypted_secret)
       values ($1,'oauth','ct') returning organization_id`,
      [server.id],
    ),
  );
  assert.equal(inserted.rows[0].organization_id, "org-a");

  // At most one org credential per server, and one row per member.
  await pool.query(
    `insert into mcp_credentials (server_id,kind,encrypted_secret)
     values ($1,'oauth','ct')`,
    [server.id],
  );
  await assert.rejects(
    pool.query(
      `insert into mcp_credentials (server_id,kind,encrypted_secret)
       values ($1,'oauth','ct2')`,
      [server.id],
    ),
    /mcp_credentials_server_org_idx/,
  );
  await pool.query(
    `insert into mcp_credentials (server_id,user_id,kind,encrypted_secret)
     values ($1,'u1','oauth','ct')`,
    [server.id],
  );
  await assert.rejects(
    pool.query(
      `insert into mcp_credentials (server_id,user_id,kind,encrypted_secret)
       values ($1,'u1','oauth','ct2')`,
      [server.id],
    ),
    /mcp_credentials_server_user_idx/,
  );

  const foreign = await asOrg("org-b", (client) =>
    client.query("select count(*)::int as n from mcp_credentials"),
  );
  assert.equal(foreign.rows[0].n, 0, "another organization must not read an MCP credential");
});

test("the tenant role cannot write MCP run grants", async () => {
  const denied = await asOrg("org-a", async (client) => {
    try {
      await client.query(
        `insert into mcp_run_grants (run_id,token_hash,expires_at)
         values ('00000000-0000-0000-0000-000000000000','h',now())`,
      );
      return null;
    } catch (err) {
      return err as Error;
    }
  });
  assert.match(denied?.message ?? "", /permission denied/);
});

/**
 * Swarm rows under org-a, so the foreign-context sweep above has
 * something to leak. A table nobody has written to reads as zero rows
 * whether its policy works or not, which is the shape of a test that
 * passes while isolating nothing.
 */
const SWARM = {
  project: "00000001-0000-0000-0000-000000000000",
  template: "60000001-0000-0000-0000-000000000000",
  swarm: "61000001-0000-0000-0000-000000000000",
  task: "62000001-0000-0000-0000-000000000000",
  profile: "63000001-0000-0000-0000-000000000000",
  run: "64000001-0000-0000-0000-000000000000",
};

test("a swarm and everything under it belongs to one organization", async () => {
  await pool.query(
    `insert into swarm_templates (id,owner_id,organization_id,name)
     values ($1,'u1','org-a','Ship a feature')`,
    [SWARM.template],
  );
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model)
     values ($1,'u1','org-a','Swarm worker','fake','fake-1')`,
    [SWARM.profile],
  );
  // Only the swarm names its organization. Everything below it is
  // inserted without one, so the triggers have to derive it.
  await pool.query(
    `insert into swarms (id,project_id,organization_id,slug,title,template_id)
     values ($1,$2,'org-a','ship','Ship it',$3)`,
    [SWARM.swarm, SWARM.project, SWARM.template],
  );
  const task = await pool.query(
    `insert into swarm_tasks (id,swarm_id,title) values ($1,$2,'Write the parser')
     returning organization_id`,
    [SWARM.task, SWARM.swarm],
  );
  assert.equal(task.rows[0].organization_id, "org-a", "a task must inherit its swarm's organization");

  const event = await pool.query(
    `insert into swarm_task_events (task_id,kind,to_status) values ($1,'status_changed','running')
     returning organization_id`,
    [SWARM.task],
  );
  assert.equal(event.rows[0].organization_id, "org-a");

  const landing = await pool.query(
    `insert into swarm_landings (swarm_id,task_id,position) values ($1,$2,0)
     returning organization_id`,
    [SWARM.swarm, SWARM.task],
  );
  assert.equal(landing.rows[0].organization_id, "org-a");

  const pr = await pool.query(
    `insert into swarm_pull_requests (swarm_id,repo_url,number,url)
     values ($1,'https://github.com/x/y',7,'https://github.com/x/y/pull/7')
     returning organization_id`,
    [SWARM.swarm],
  );
  assert.equal(pr.rows[0].organization_id, "org-a");

  const message = await pool.query(
    `insert into swarm_messages (swarm_id,text) values ($1,'split that task further')
     returning organization_id`,
    [SWARM.swarm],
  );
  assert.equal(message.rows[0].organization_id, "org-a", "a null task_id is the planner, not a missing tenant");
});

test("another organization reads nothing of a swarm", async () => {
  // Runs after the seeding test, so every one of these tables has rows
  // to withhold. The policy is the only thing between them and org-b.
  const tables = [
    "swarm_templates",
    "swarms",
    "swarm_tasks",
    "swarm_task_events",
    "swarm_landings",
    "swarm_pull_requests",
    "swarm_messages",
  ];
  const owner = await pool.query(
    `select count(*)::int as n from swarm_tasks where organization_id = 'org-a'`,
  );
  assert.ok(owner.rows[0].n > 0, "the fixtures must exist, or this test proves nothing");

  await asOrg("org-b", async (client) => {
    for (const table of tables) {
      const { rows } = await client.query(`select count(*)::int as n from ${table}`);
      assert.equal(rows[0].n, 0, `${table} leaked ${rows[0].n} row(s) to another organization`);
    }
  });
  // And the owner can still read its own, so the policy is confining
  // rather than simply denying.
  const mine = await asOrg("org-a", (client) => client.query("select title from swarm_tasks"));
  assert.deepEqual(mine.rows.map((r) => r.title), ["Write the parser"]);
});

test("a swarm task cannot be smuggled into another organization", async () => {
  await assert.rejects(
    asOrg("org-a", (client) =>
      client.query(
        `insert into swarm_tasks (swarm_id,organization_id,title) values ($1,'org-b','smuggled')`,
        [SWARM.swarm],
      ),
    ),
    /row-level security/,
  );
});

test("one swarm lands one branch at a time", async () => {
  // The merge queue's whole promise. A job option can be forgotten by
  // the next caller; a partial unique index cannot.
  await pool.query(
    `insert into swarm_landings (swarm_id,task_id,position,status) values ($1,$2,1,'landing')`,
    [SWARM.swarm, SWARM.task],
  );
  await assert.rejects(
    pool.query(
      `insert into swarm_landings (swarm_id,task_id,position,status) values ($1,$2,2,'landing')`,
      [SWARM.swarm, SWARM.task],
    ),
    /swarm_landings_one_in_flight_idx/,
    "two landings must not be in flight on one swarm",
  );
  // Anything else queues freely: the index is on the in-flight state,
  // not on the queue.
  await pool.query(
    `insert into swarm_landings (swarm_id,task_id,position,status) values ($1,$2,3,'queued')`,
    [SWARM.swarm, SWARM.task],
  );
});

test("a run belongs to a card or to a swarm, never to both and never to neither", async () => {
  const featureA = "40000001-0000-0000-0000-000000000000";
  const stageA = "20000001-0000-0000-0000-000000000000";
  await assert.rejects(
    pool.query(
      `insert into agent_runs (feature_id,stage_id,swarm_id,agent_profile_id,organization_id,prompt,role)
       values ($1,$2,$3,$4,'org-a','both','worker')`,
      [featureA, stageA, SWARM.swarm, SWARM.profile],
    ),
    /agent_runs_feature_or_swarm/,
  );
  // A run naming neither is refused too, though the tenant trigger
  // gets there first: BEFORE triggers run ahead of check constraints,
  // and a run with no card takes the pipeline branch and finds no
  // stage. Refused either way, which is what matters.
  await assert.rejects(
    pool.query(
      `insert into agent_runs (agent_profile_id,organization_id,prompt) values ($1,'org-a','neither')`,
      [SWARM.profile],
    ),
    /must name its stage/,
  );
});

test("a swarm run passes the tenant check in multi mode", async () => {
  /**
   * The reason this test is here at all. The run tenant trigger used to
   * dereference feature_id and stage_id unconditionally, which a swarm
   * run leaves null. With an organization set, the derived feature
   * organization came back null, IS DISTINCT FROM was true, and every
   * swarm run was refused at the database edge. Locally the same insert
   * succeeded, because there everything compared is null.
   */
  const inserted = await pool.query(
    `insert into agent_runs (id,swarm_id,swarm_task_id,agent_profile_id,organization_id,prompt,role)
     values ($1,$2,$3,$4,'org-a','work the leaf','worker')
     returning organization_id, role`,
    [SWARM.run, SWARM.swarm, SWARM.task, SWARM.profile],
  );
  assert.equal(inserted.rows[0].organization_id, "org-a");
  assert.equal(inserted.rows[0].role, "worker");

  // A planner run names no task, and is still a swarm run.
  const planner = await pool.query(
    `insert into agent_runs (swarm_id,agent_profile_id,organization_id,prompt,role)
     values ($1,$2,'org-a','plan the goal','planner') returning organization_id`,
    [SWARM.swarm, SWARM.profile],
  );
  assert.equal(planner.rows[0].organization_id, "org-a");
});

test("a swarm run derives its organization when the insert omits one", async () => {
  const derived = await asOrg("org-a", (client) =>
    client.query(
      `insert into agent_runs (swarm_id,agent_profile_id,prompt,role)
       values ($1,$2,'derive me','worker') returning organization_id`,
      [SWARM.swarm, SWARM.profile],
    ),
  );
  assert.equal(derived.rows[0].organization_id, "org-a", "the inherit trigger must read whichever parent is set");
});

test("a swarm run cannot reference another tenant's swarm, task or agent", async () => {
  const projectB = "00000002-0000-0000-0000-000000000000";
  const swarmB = "61000002-0000-0000-0000-000000000000";
  const taskB = "62000002-0000-0000-0000-000000000000";
  const profileB = "63000002-0000-0000-0000-000000000000";
  await pool.query(
    `insert into swarms (id,project_id,organization_id,slug,title) values ($1,$2,'org-b','ship','Ship it too')`,
    [swarmB, projectB],
  );
  await pool.query(`insert into swarm_tasks (id,swarm_id,title) values ($1,$2,'Theirs')`, [taskB, swarmB]);
  await pool.query(
    `insert into agent_profiles (id,owner_id,organization_id,name,cli,model)
     values ($1,'u1','org-b','Theirs','fake','fake-1')`,
    [profileB],
  );

  // Their agent on our swarm.
  await assert.rejects(
    pool.query(
      `insert into agent_runs (swarm_id,agent_profile_id,organization_id,prompt,role)
       values ($1,$2,'org-a','borrowed agent','worker')`,
      [SWARM.swarm, profileB],
    ),
    /organization or swarm boundary/,
  );
  // Their task on our swarm.
  await assert.rejects(
    pool.query(
      `insert into agent_runs (swarm_id,swarm_task_id,agent_profile_id,organization_id,prompt,role)
       values ($1,$2,$3,'org-a','borrowed task','worker')`,
      [SWARM.swarm, taskB, SWARM.profile],
    ),
    /organization or swarm boundary/,
  );
  // Our swarm, claimed for their organization.
  await assert.rejects(
    pool.query(
      `insert into agent_runs (swarm_id,agent_profile_id,organization_id,prompt,role)
       values ($1,$2,'org-b','wrong tenant','worker')`,
      [SWARM.swarm, SWARM.profile],
    ),
    /organization or swarm boundary/,
  );
});

test("a swarm run passes the tenant check in local mode", async () => {
  /**
   * Local mode is the other half, and the half a swarm test suite would
   * be tempted to stop at: no organizations, so every column compared
   * is null. The same rows still have to insert, and a run that reaches
   * across into an organization's agent still has to be refused, or
   * "works locally" would mean nothing at all.
   */
  const project = "00000009-0000-0000-0000-000000000000";
  const swarm = "61000009-0000-0000-0000-000000000000";
  const task = "62000009-0000-0000-0000-000000000000";
  const profile = "63000009-0000-0000-0000-000000000000";
  await pool.query(
    `insert into projects (id,owner_id,organization_id,name,default_branch)
     values ($1,'u1',null,'local project','main')`,
    [project],
  );
  await pool.query(
    `insert into swarms (id,project_id,slug,title) values ($1,$2,'local','Local swarm')`,
    [swarm, project],
  );
  const localSwarm = await pool.query("select organization_id from swarms where id = $1", [swarm]);
  assert.equal(localSwarm.rows[0].organization_id, null, "local mode has no organization to inherit");

  await pool.query(`insert into swarm_tasks (id,swarm_id,title) values ($1,$2,'Local leaf')`, [task, swarm]);
  await pool.query(
    `insert into agent_profiles (id,owner_id,name,cli,model) values ($1,'u1','Local','fake','fake-1')`,
    [profile],
  );

  const run = await pool.query(
    `insert into agent_runs (swarm_id,swarm_task_id,agent_profile_id,prompt,role)
     values ($1,$2,$3,'work locally','worker') returning organization_id, feature_id, stage_id`,
    [swarm, task, profile],
  );
  assert.equal(run.rows[0].organization_id, null);
  assert.equal(run.rows[0].feature_id, null);
  assert.equal(run.rows[0].stage_id, null);

  // Local rows and a tenant's rows still may not be mixed, in either
  // direction: nulls compare with IS DISTINCT FROM, not with =.
  await assert.rejects(
    pool.query(
      `insert into agent_runs (swarm_id,agent_profile_id,prompt,role)
       values ($1,$2,'local swarm, tenant agent','worker')`,
      [swarm, SWARM.profile],
    ),
    /organization or swarm boundary/,
  );
});

test("a card run still has to name its stage", async () => {
  // stage_id lost its NOT NULL so a swarm run could leave it empty. The
  // pipeline's own requirement moved into the trigger rather than being
  // dropped.
  const featureA = "40000001-0000-0000-0000-000000000000";
  await assert.rejects(
    pool.query(
      `insert into agent_runs (feature_id,agent_profile_id,organization_id,prompt)
       values ($1,$2,'org-a','no stage')`,
      [featureA, SWARM.profile],
    ),
    /must name its stage/,
  );
});
