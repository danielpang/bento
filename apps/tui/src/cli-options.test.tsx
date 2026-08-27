import assert from "node:assert/strict";
import test from "node:test";
import { HELP } from "./cli-options.js";

test("bento --help lists all preview and production tool values", () => {
  assert.match(HELP, /--tool[\s\S]*pool/);
  assert.match(HELP, /--tool[\s\S]*dsh/);
});
