import assert from "node:assert/strict";
import test from "node:test";
import { isSpendRun } from "./enums.js";

test("spend counts finished work, not judges or in-flight runs", () => {
  assert.equal(isSpendRun({ status: "succeeded" }), true);
  assert.equal(isSpendRun({ status: "failed", kind: "task" }), true);
  assert.equal(isSpendRun({ status: "cancelled" }), true);
  assert.equal(isSpendRun({ status: "succeeded", kind: "judge" }), false);
  assert.equal(isSpendRun({ status: "running" }), false);
  assert.equal(isSpendRun({ status: "queued", kind: "task" }), false);
  assert.equal(isSpendRun({ status: "starting" }), false);
});
