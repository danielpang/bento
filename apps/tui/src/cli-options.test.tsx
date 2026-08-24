import assert from "node:assert/strict";
import test from "node:test";
import { HELP } from "./cli-options.js";

test("bento --help lists pool among --tool values", () => {
  assert.match(HELP, /--tool[\s\S]*pool/);
});
