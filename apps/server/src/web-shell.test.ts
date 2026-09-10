import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadWebShell, readBuildId } from "./web-shell.js";

test("reads the build id the Vite build stamps into the head", () => {
  assert.equal(
    readBuildId('<!doctype html><html><head><meta name="bento-build" content="7225d36c"><meta charset="utf-8"></head></html>'),
    "7225d36c",
  );
  // Attribute order is the build's to choose.
  assert.equal(readBuildId('<meta content="abc123" name="bento-build" />'), "abc123");
});

test("a shell without the tag has no id", () => {
  assert.equal(readBuildId('<html><head><meta name="viewport" content="width=device-width"></head></html>'), null);
  assert.equal(readBuildId('<meta name="bento-build" content="  ">'), null);
});

test("loads the shell once, with its id, and reports a missing one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-web-"));
  assert.equal(loadWebShell(dir), null);
  await writeFile(path.join(dir, "index.html"), '<html><head><meta name="bento-build" content="deadbeef"></head></html>');
  const shell = loadWebShell(dir);
  assert.equal(shell?.build, "deadbeef");
  assert.match(shell?.html ?? "", /deadbeef/);
});
