import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientConnectionError } from "./client.js";

test("a dropped-socket read is transient", () => {
  assert.equal(isTransientConnectionError(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" })), true);
  assert.equal(isTransientConnectionError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
});

test("a real fault is not transient", () => {
  assert.equal(isTransientConnectionError(new Error("syntax error at or near")), false);
  assert.equal(isTransientConnectionError(Object.assign(new Error("bad password"), { code: "28P01" })), false);
});

test("non-errors do not throw", () => {
  assert.equal(isTransientConnectionError(null), false);
  assert.equal(isTransientConnectionError(undefined), false);
  assert.equal(isTransientConnectionError("ETIMEDOUT"), false);
});
