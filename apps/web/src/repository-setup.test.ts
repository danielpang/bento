import assert from "node:assert/strict";
import test from "node:test";
import { repositoriesMissing } from "./repository-setup.js";

/**
 * The drawer decides "no repositories" from this. A static render of
 * the drawer cannot show it: the list arrives in an effect, and a
 * failed effect used to leave the same empty array as a real empty
 * project, which disabled Start pipeline.
 */
test("repositoriesMissing is true only for a list that was read and is empty", () => {
  assert.equal(repositoriesMissing(null, false), false);
  assert.equal(repositoriesMissing(null, true), false);
  assert.equal(repositoriesMissing([], true), false);
  assert.equal(repositoriesMissing([], false), true);
  assert.equal(repositoriesMissing([{ id: "repo" }], false), false);
  assert.equal(repositoriesMissing([{ id: "repo" }], true), false);
});
