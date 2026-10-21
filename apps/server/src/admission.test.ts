import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail } from "./admission.js";

test("normalizeEmail trims and lowercases without folding plus aliases", () => {
  assert.equal(normalizeEmail("  Ada.Lovelace+beta@Example.COM "), "ada.lovelace+beta@example.com");
  assert.equal(normalizeEmail("already@ok.test"), "already@ok.test");
});
