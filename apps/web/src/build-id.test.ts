import assert from "node:assert/strict";
import test from "node:test";
import { buildIdFor } from "./build-id.js";

test("the source commit is the id when the build has one", () => {
  assert.equal(buildIdFor("  7225d36c  ", ["assets/index-abc.js"]), "7225d36c");
});

test("a commit that cannot travel in a header falls back to the hash", () => {
  assert.match(buildIdFor("release 1.0\n", ["assets/index-abc.js"])!, /^[0-9a-f]{16}$/);
  assert.match(buildIdFor('v1&"x', ["assets/index-abc.js"])!, /^[0-9a-f]{16}$/);
});

test("without a commit the id follows the emitted file names", () => {
  const a = buildIdFor(undefined, ["index.html", "assets/index-abc.js", "assets/vendor-111.js"]);
  const same = buildIdFor("", ["assets/vendor-111.js", "assets/index-abc.js", "index.html"]);
  const changed = buildIdFor(undefined, ["index.html", "assets/index-def.js", "assets/vendor-111.js"]);
  assert.equal(a, same, "order and the shell itself do not change the id");
  assert.notEqual(a, changed, "a rebuilt chunk changes the id");
  assert.match(a!, /^[0-9a-f]{16}$/);
});

test("a build that emitted nothing has no id", () => {
  assert.equal(buildIdFor(undefined, []), null);
  assert.equal(buildIdFor(undefined, ["index.html"]), null);
});
