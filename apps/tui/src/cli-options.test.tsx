import assert from "node:assert/strict";
import test from "node:test";
import { HELP, parseCliOptions } from "./cli-options.js";

test("uninstall is a standalone command without a confirmation bypass", () => {
  assert.equal(parseCliOptions(["uninstall"]).command, "uninstall");
  assert.match(HELP, /^ {2}uninstall\s/m);
  assert.throws(() => parseCliOptions(["uninstall", "--yes"]));
  assert.throws(() => parseCliOptions(["uninstall", "Y"]));
});

test("update is a standalone command with no version argument", () => {
  assert.equal(parseCliOptions(["update"]).command, "update");
  assert.match(HELP, /^ {2}update\s/m);
  assert.throws(() => parseCliOptions(["update", "v1.2.3"]));
});

test("omitting the login-sharing flag leaves saved settings and the environment in control", () => {
  assert.equal(parseCliOptions([]).shareAgentAuth, undefined);
  assert.equal(parseCliOptions(["serve"]).shareAgentAuth, undefined);
  assert.equal(parseCliOptions(["--share-agent-auth"]).shareAgentAuth, true);
});

test("bento --help lists all preview and production tool values", () => {
  assert.match(HELP, /--tool[\s\S]*pool/);
  assert.match(HELP, /--tool[\s\S]*dsh/);
  assert.match(HELP, /--tool[\s\S]*antigravity/);
  assert.match(HELP, /--tool[\s\S]*muse/);
  assert.match(HELP, /--tool[\s\S]*fx/);
});

test("bento --help lists spend, sessions, and mcp", () => {
  assert.match(HELP, /^ {2}spend/m);
  assert.match(HELP, /^ {2}sessions/m);
  assert.match(HELP, /^ {2}mcp \[list\]/m);
  assert.match(HELP, /mcp add <name> --url/);
});

test("--base-branch is kept for repos add and repos set, and blank means detect again", () => {
  const add = parseCliOptions(["repos", "add", "../api", "--base-branch", " master "]);
  assert.deepEqual(add.positionals, ["add", "../api"]);
  assert.equal(add.baseBranch, "master");
  assert.equal(parseCliOptions(["repos", "set", "api", "--base-branch", ""]).baseBranch, "");
  assert.equal(parseCliOptions(["repos", "add", "../api"]).baseBranch, undefined);
  assert.match(HELP, /--base-branch <branch>/);
});
