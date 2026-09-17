import assert from "node:assert/strict";
import test from "node:test";
import { duplicateRepositoryLocation, sameRepositoryLocation } from "./repository-identity.js";

test("repository identity catches repeated mount paths and GitHub selections", () => {
  const first = { localPath: "/Users/me/projects/bento", githubRepoId: null };
  assert.equal(sameRepositoryLocation(first, { ...first, localPath: "/Users/me/projects/bento/" }), true);
  assert.equal(sameRepositoryLocation(first, { ...first, localPath: "/Users/me/projects/other" }), false);
  assert.equal(
    sameRepositoryLocation(
      { localPath: "team/bento", githubRepoId: "123" },
      { localPath: "team/renamed-bento", githubRepoId: "123" },
    ),
    true,
  );
  assert.deepEqual(
    duplicateRepositoryLocation([
      { ...first, name: "bento" },
      { ...first, localPath: "/Users/me/projects/bento/", name: "bento-2" },
    ])?.map((row) => row.name),
    ["bento", "bento-2"],
  );
});
