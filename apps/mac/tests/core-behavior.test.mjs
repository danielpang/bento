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
  assert.ok(!result.commands.some((line) => /\/(advance|back|approve|reject|recheck|quick-run)/.test(line)));
});
