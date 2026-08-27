import assert from "node:assert/strict";
import test from "node:test";
import { poolMaxForRuns } from "@bento/db";

test("a laptop's 4 workers still leave headroom for HTTP", () => {
  assert.equal(poolMaxForRuns(4), 20);
});

test("hosted worker count gets a connection per run plus headroom", () => {
  assert.equal(poolMaxForRuns(32), 48);
});
