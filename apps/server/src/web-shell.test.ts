import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWebShell, readBuildId } from "./web-shell.js";

test("reads the build id the Vite build stamps into the head", () => {
  assert.equal(
    readBuildId('<!doctype html><html><head><meta name="bento-build" content="7225d36c"><meta charset="utf-8"></head></html>'),
    "7225d36c",
  );
  // Attribute order is the build's to choose.
  assert.equal(readBuildId('<meta content="abc123" name="bento-build" />'), "abc123");
});

test("a shell without a usable tag has no id", () => {
  assert.equal(readBuildId('<html><head><meta name="viewport" content="width=device-width"></head></html>'), null);
  assert.equal(readBuildId('<meta name="bento-build" content="  ">'), null);
  // Not header-safe, so not an id.
  assert.equal(readBuildId('<meta name="bento-build" content="v1&amp;x">'), null);
});

test("follows the shell on disk, and reports a missing one", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shell = createWebShell(dir);
  assert.equal(shell.load(), null);
  assert.equal(shell.build, null);

  await writeFile(path.join(dir, "index.html"), '<html><head><meta name="bento-build" content="deadbeef"></head></html>');
  assert.equal(shell.load()?.build, "deadbeef");
  assert.equal(shell.build, "deadbeef");

  // A rebuild under a running server moves the id with the bytes.
  await writeFile(path.join(dir, "index.html"), '<html><head><meta name="bento-build" content="cafef00d"></head></html>');
  assert.match(shell.load()?.html ?? "", /cafef00d/);
  assert.equal(shell.build, "cafef00d");
});
