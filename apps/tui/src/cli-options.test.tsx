import assert from "node:assert/strict";
import test from "node:test";
import { HELP } from "./cli-options.js";

test("bento --help lists all preview and production tool values", () => {
  assert.match(HELP, /--tool[\s\S]*pool/);
  assert.match(HELP, /--tool[\s\S]*dsh/);
  assert.match(HELP, /--tool[\s\S]*antigravity/);
});

test("bento --help lists spend, sessions, and mcp", () => {
  assert.match(HELP, /^ {2}spend/m);
  assert.match(HELP, /^ {2}sessions/m);
  assert.match(HELP, /^ {2}mcp \[list\]/m);
  assert.match(HELP, /mcp add <name> --url/);
});
