import { test } from "node:test";
import assert from "node:assert/strict";
import { hashGrantToken } from "./grants.js";

// The pure token helpers are unit-testable without a database; the
// mint/revoke/extend lifecycle is exercised end to end in
// gateway.e2e.test.ts against a real grant row.

test("the token hash is a stable sha256 hex digest", () => {
  const hash = hashGrantToken("bmg_example-token");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashGrantToken("bmg_example-token"), "hashing is deterministic");
  assert.notEqual(hash, hashGrantToken("bmg_other-token"), "different tokens hash differently");
});
