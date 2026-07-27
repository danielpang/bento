import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRepositoryPath,
  repositoryNameHint,
  repositoryPathOwnerForMode,
} from "./repository-path.js";

test("only thin-client mode treats repository paths as server-owned", () => {
  assert.equal(repositoryPathOwnerForMode("client"), "server");
  assert.equal(repositoryPathOwnerForMode("runner"), "client");
  assert.equal(repositoryPathOwnerForMode("local"), "client");
});

test("server repository paths are transported without client resolution", () => {
  assert.equal(prepareRepositoryPath("../checkouts/api", "server"), "../checkouts/api");
  assert.equal(prepareRepositoryPath("~/checkouts/api", "server"), "~/checkouts/api");
  assert.equal(prepareRepositoryPath("  /srv/repos/api  ", "server"), "/srv/repos/api");
});

test("client repository paths are resolved on the client", () => {
  assert.equal(prepareRepositoryPath("~/checkouts/api", "client"), path.join(os.homedir(), "checkouts/api"));
  assert.equal(prepareRepositoryPath("../checkouts/api", "client"), path.resolve("../checkouts/api"));
});

test("empty path input stays empty instead of becoming the client cwd", () => {
  assert.equal(prepareRepositoryPath("   ", "client"), "");
  assert.equal(prepareRepositoryPath("   ", "server"), "");
});

test("repository name hints are lexical and accept server path separators", () => {
  assert.equal(repositoryNameHint("/srv/repos/api/"), "api");
  assert.equal(repositoryNameHint(String.raw`C:\repos\web`), "web");
});
