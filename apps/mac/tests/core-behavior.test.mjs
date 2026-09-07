import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const native = fileURLToPath(new URL("../../../node_modules/.bin/native", import.meta.url));

function bytes(value) {
  return { $bytes: value };
}

function runCore(messages) {
  const result = spawnSync(native, ["dev", "--core"], {
    cwd: appDir,
    encoding: "utf8",
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = result.stdout.split("\n");
  return {
    models: lines.filter((line) => line.startsWith("model ")).map((line) => JSON.parse(line.slice(6))),
    commands: lines.filter((line) => line.startsWith("cmd ")),
  };
}

function insert(value) {
  return { kind: "insert_text", text: bytes(value) };
}

test("editing preserves a model absent from the catalog", () => {
  const result = runCore([
    {
      kind: "profiles_ok",
      status: 200,
      body: bytes("profile|p1|claude-code|retired-model|anthropic|compatible|Reviewer"),
    },
    { kind: "tools_ok", status: 200, body: bytes("tool|claude-code|default-model|Claude Code") },
    { kind: "edit_profile", index: 0 },
    { kind: "catalog_ok", status: 200, body: bytes("model|anthropic|default|default-model|Default") },
    { kind: "agent_name_edit", edit: insert(" updated") },
    { kind: "submit_agent" },
  ]);

  const patch = result.commands.find((line) => line.includes('method="PATCH"'));
  assert.ok(patch, "expected an agent PATCH");
  assert.match(patch, /\\"name\\":\\"Reviewer updated\\"/);
  assert.match(patch, /\\"model\\":\\"retired-model\\"/);
  assert.doesNotMatch(patch, /\\"model\\":\\"default-model\\"/);
});

test("the first created project is selected and loaded", () => {
  const result = runCore([
    { kind: "open_new_project" },
    { kind: "project_name_edit", edit: insert("First project") },
    { kind: "project_path_edit", edit: insert("/tmp/first") },
    { kind: "submit_project" },
    { kind: "projects_changed", status: 201, body: bytes("") },
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|First project") },
  ]);

  const model = result.models.at(-1);
  assert.equal(model.selectedProject, 0);
  assert.equal(model.selectCreatedProject, false);
  assert.ok(result.commands.some((line) => line.includes("/api/projects/project-1/board/plain")));
  assert.ok(result.commands.some((line) => line.includes("/api/projects/project-1/pipeline/plain")));
  assert.ok(result.commands.some((line) => line.includes("/api/projects/project-1/repositories/plain")));
});

test("creating a project keeps the dialog open until the server accepts", () => {
  const result = runCore([
    { kind: "open_new_project" },
    { kind: "project_name_edit", edit: insert("Missing path") },
    { kind: "project_path_edit", edit: insert("/Users/you/code/checkout") },
    { kind: "submit_project" },
  ]);

  const afterSubmit = result.models.at(-1);
  assert.equal(afterSubmit.dialog, "new_project");
  assert.match(afterSubmit.notice.$bytes, /Creating/);
  assert.ok(result.commands.some((line) => line.includes("/api/projects") && line.includes('method="POST"')));
});

test("a refused project create shows the server error and leaves the dialog open", () => {
  const result = runCore([
    { kind: "open_new_project" },
    { kind: "project_name_edit", edit: insert("Missing path") },
    { kind: "project_path_edit", edit: insert("/Users/you/code/checkout") },
    { kind: "submit_project" },
    {
      kind: "projects_changed",
      status: 400,
      body: bytes('{"error":"/Users/you/code/checkout does not exist on the machine running the server."}'),
    },
  ]);

  const model = result.models.at(-1);
  assert.equal(model.dialog, "new_project");
  assert.equal(
    model.lastError.$bytes,
    "/Users/you/code/checkout does not exist on the machine running the server.",
  );
  assert.equal(model.notice.$bytes, "");
});

test("Pipeline opens from the project picker by selecting the first project", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|First project") },
    { kind: "open_pipeline" },
  ]);

  const model = result.models.at(-1);
  assert.equal(model.panel, "pipeline");
  assert.equal(model.selectedProject, 0);
  assert.ok(result.commands.some((line) => line.includes("/api/projects/project-1/pipeline/plain")));
  assert.ok(result.commands.some((line) => line.includes("/api/projects/project-1/repositories/plain")));
});

test("switching organizations drops stale project state and reloads scoped data", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|old-project|Old project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes("stage|stage-1|0|Build\nfeature|card-1|stage-1|active|-|-|-|-|Old card"),
    },
    {
      kind: "team_ok",
      status: 200,
      body: bytes("mode|multi\norg|old-org|1|admin|Old\norg|new-org|0|admin|New"),
    },
    { kind: "switch_org", index: 1 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes("stage|stage-1|0|Build\nfeature|stale|stage-1|active|-|-|-|-|Stale card"),
    },
    { kind: "team_changed", status: 200, body: bytes("") },
  ]);

  const switching = result.models.find((model) => model.switchingOrganization);
  assert.ok(switching, "expected organization switching state");
  assert.equal(switching.selectedProject, -1);
  assert.deepEqual(switching.projects, []);
  assert.deepEqual(switching.cards, []);

  const model = result.models.at(-1);
  assert.equal(model.switchingOrganization, false);
  assert.deepEqual(model.cards, [], "a late board response must not restore the old board");
  for (const path of ["/api/team/plain", "/api/projects/plain", "/api/profiles/plain", "/api/secrets/plain"]) {
    assert.ok(result.commands.some((line) => line.includes(path)), `expected refresh for ${path}`);
  }
});

test("cancelled cards reject movement and stage actions", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes("stage|stage-1|0|Build\nfeature|card-1|stage-1|cancelled|-|-|-|-|Cancelled card"),
    },
    { kind: "pick_card", index: 0 },
    { kind: "card_fwd", index: 0 },
    { kind: "card_back", index: 0 },
    { kind: "approve" },
    { kind: "reject" },
    { kind: "send_back" },
    { kind: "recheck" },
    { kind: "run_fake" },
  ]);

  const model = result.models.at(-1);
  assert.equal(model.cards[0].canBack, false);
  assert.equal(model.cards[0].canFwd, false);
  assert.equal(model.cards[0].finished, true);
  assert.ok(!result.commands.some((line) => /\/(advance|back|approve|reject|recheck|quick-run|finish)/.test(line)));
});

test("finished cards leave their stage and can be marked completed or deleted", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes(
        "stage|stage-1|0|Build\nfeature|live|stage-1|active|-|-|-|-|Live card\nfeature|shipped|stage-1|done|-|-|-|-|Shipped card",
      ),
    },
    { kind: "pick_card", index: 0 },
    { kind: "finish" },
    { kind: "delete_card" },
    { kind: "confirm_delete_card" },
  ]);

  const afterBoard = result.models.find((model) => model.cards?.length === 2);
  assert.ok(afterBoard, "expected both cards to parse");
  assert.equal(afterBoard.cards[0].finished, false);
  assert.equal(afterBoard.cards[1].finished, true);
  assert.equal(afterBoard.cards[1].canFwd, false);

  const finish = result.commands.find((line) => line.includes("/api/features/live/finish"));
  assert.ok(finish, "expected a finish POST");
  assert.match(finish, /body=/);

  const confirm = result.models.find((model) => model.dialog === "confirm");
  assert.ok(confirm, "expected a delete confirmation");

  assert.ok(
    result.commands.some((line) => line.includes('method="DELETE"') && line.includes("/api/features/live")),
    "expected a card DELETE",
  );
});

test("a stage can be added, removed, and told to open a pull request", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "pipeline_ok",
      status: 200,
      body: bytes("pipeline|pipe-1\nstage|stage-1|0|-|manual|0|Build"),
    },
    { kind: "open_new_stage" },
    { kind: "stage_name_edit", edit: insert("Security review") },
    { kind: "submit_new_stage" },
    { kind: "delete_stage", index: 0 },
    { kind: "confirm_delete_stage" },
    { kind: "edit_stage", index: 0 },
    { kind: "toggle_create_pr" },
  ]);

  const created = result.commands.find((line) => line.includes("/api/stages") && line.includes('method="POST"'));
  assert.ok(created, "expected a create-stage POST");
  assert.match(created, /\\"pipelineId\\":\\"pipe-1\\"/);
  assert.match(created, /\\"name\\":\\"Security review\\"/);

  assert.ok(
    result.commands.some((line) => line.includes('method="DELETE"') && line.includes("/api/stages/stage-1")),
    "expected a stage DELETE",
  );

  const pr = result.commands.find((line) => line.includes("/api/stages/stage-1") && line.includes('method="PATCH"') && line.includes("createPr"));
  assert.ok(pr, "expected a createPr PATCH");
  assert.match(pr, /\\"createPr\\":true/);
});

test("a conflicted pull request can start a resolve-conflicts run", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes("stage|stage-1|0|Build\nfeature|card-1|stage-1|active|succeeded|run-1|-|-|Conflicted card"),
    },
    { kind: "pick_card", index: 0 },
    { kind: "merge_ok", status: 200, body: bytes("pr|conflicted|41|checkout") },
    { kind: "resolve_conflicts" },
  ]);

  assert.ok(
    result.commands.some((line) => line.includes("/api/features/card-1/merge-status/plain")),
    "expected a merge-status read when the card opens",
  );

  const afterMerge = result.models.find((model) => model.hasConflicts);
  assert.ok(afterMerge, "expected hasConflicts after a conflicted merge-status");

  const resolve = result.commands.find((line) => line.includes("/api/features/card-1/resolve-conflicts"));
  assert.ok(resolve, "expected a resolve-conflicts POST");
  assert.match(resolve, /method="POST"/);
  assert.match(resolve, /body=/);
});

test("resolve-conflicts waits when an agent is already working the card", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes("stage|stage-1|0|Build\nfeature|card-1|stage-1|active|running|run-1|-|-|Busy card"),
    },
    { kind: "pick_card", index: 0 },
    { kind: "merge_ok", status: 200, body: bytes("pr|conflicted|41|checkout") },
    { kind: "resolve_conflicts" },
  ]);

  const notice = result.models.filter((model) => model.notice?.$bytes).at(-1)?.notice?.$bytes ?? "";
  assert.match(notice, /Resolve conflicts when it finishes/);
  assert.ok(!result.commands.some((line) => line.includes("/resolve-conflicts")));
});

test("a stage save can name a judge agent", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "profiles_ok",
      status: 200,
      body: bytes("profile|judge-1|claude-code|claude-sonnet-5|anthropic|compatible|Reviewer"),
    },
    {
      kind: "pipeline_ok",
      status: 200,
      body: bytes("pipeline|pipe-1\nstage|stage-1|0|-|auto|0|Build\ncriterion|stage-1|0|agent_judge|-|judge-1"),
    },
    { kind: "edit_stage", index: 0 },
    { kind: "set_gate_judge", index: 0 },
    { kind: "submit_gate" },
  ]);

  const patch = result.commands.find((line) => line.includes("/api/stages/stage-1") && line.includes("gateCriteria"));
  assert.ok(patch, "expected a gate PATCH");
  assert.match(patch, /agent_judge/);
  assert.match(patch, /judge-1/);
});

test("repository setup and test commands can be saved", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "repos_ok",
      status: 200,
      body: bytes("repo|repo-1|api|/tmp/api\nsetup|repo-1|npm ci\ntest|repo-1|npm test"),
    },
    { kind: "edit_repo", index: 0 },
    { kind: "submit_repo_commands" },
  ]);

  const after = result.models.find((model) => model.repos?.length === 1);
  assert.ok(after, "expected the repo to parse with commands");
  assert.equal(after.repos[0].setupCommand.$bytes, "npm ci");
  assert.equal(after.repos[0].testCommand.$bytes, "npm test");

  const patch = result.commands.find((line) => line.includes("/repositories/repo-1") && line.includes('method="PATCH"'));
  assert.ok(patch, "expected a repository commands PATCH");
  assert.match(patch, /setupCommand/);
  assert.match(patch, /testCommand/);
});

test("spend and sessions panels fetch their plain listings", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    { kind: "open_spend" },
    { kind: "open_sessions" },
    { kind: "open_mcp" },
  ]);

  assert.ok(result.commands.some((line) => line.includes("/usage/plain")), "expected a spend read");
  assert.ok(result.commands.some((line) => line.includes("/sessions/plain")), "expected a sessions read");
  assert.ok(result.commands.some((line) => line.includes("/api/mcp/plain")), "expected an MCP read");
});

test("resolve-conflicts stays quiet when GitHub reports no conflict", () => {
  const result = runCore([
    { kind: "projects_ok", status: 200, body: bytes("project|project-1|Project") },
    { kind: "pick_project", index: 0 },
    {
      kind: "board_ok",
      status: 200,
      body: bytes("stage|stage-1|0|Build\nfeature|card-1|stage-1|active|succeeded|run-1|-|-|Clean card"),
    },
    { kind: "pick_card", index: 0 },
    { kind: "merge_ok", status: 200, body: bytes("pr|clean|41|checkout") },
    { kind: "resolve_conflicts" },
  ]);

  assert.ok(!result.commands.some((line) => line.includes("/resolve-conflicts")));
});

test("local mode spawns the bundled helper path when set", () => {
  const result = runCore([
    { kind: "helper_path", path: bytes("/Applications/Bento.app/Contents/Resources/helper/bento") },
    { kind: "choose_local" },
  ]);

  const spawn = result.commands.find((line) => line.includes("spawn") || line.includes("serve"));
  assert.ok(spawn, `expected a helper spawn, got: ${result.commands.join("\n")}`);
  assert.match(spawn, /Resources\/helper\/bento/);
  assert.match(spawn, /serve/);
  assert.doesNotMatch(spawn, /"bento" "serve"/);
});
