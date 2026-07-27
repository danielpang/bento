import { test } from "node:test";
import assert from "node:assert/strict";
import { sameBinds } from "./docker.js";

// sameBinds is what decides whether a sandbox is reused or rebuilt, so
// its edges are pinned here rather than left to a live Docker daemon.

test("identical mounts in any order are the same sandbox", () => {
  assert.ok(sameBinds(["/a:/workspace", "/b:/x:ro"], ["/b:/x:ro", "/a:/workspace"]));
});

test("a moved workspace means a different sandbox", () => {
  assert.ok(!sameBinds(["/old/worktrees/f:/workspace"], ["/new/worktrees/f:/workspace"]));
});

test("a dropped credential mount means a different sandbox", () => {
  assert.ok(!sameBinds(["/w:/workspace", "/home/u/.claude:/root/.claude:ro"], ["/w:/workspace"]));
});
