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
