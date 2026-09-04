import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { LocalProcessDriver } from "./local-process.js";
import { collectExec } from "./driver.js";

test("local driver streams stdout and exit code", async () => {
  const driver = new LocalProcessDriver();
  const handle = await driver.provision({
    projectId: "p1",
    workspaceKey: "f1",
    hostWorkspacePath: tmpdir(),
  });
  const result = await collectExec(driver.exec(handle, ["sh", "-c", "echo hello; echo err >&2; exit 3"]));
  assert.equal(result.stdout.trim(), "hello");
  assert.equal(result.stderr.trim(), "err");
  assert.equal(result.exitCode, 3);
});

test("local driver reports missing binary as exit 127", async () => {
  const driver = new LocalProcessDriver();
  const handle = await driver.provision({
    projectId: "p1",
    workspaceKey: "f2",
    hostWorkspacePath: tmpdir(),
  });
  const result = await collectExec(driver.exec(handle, ["definitely-not-a-real-binary-xyz"]));
  assert.equal(result.exitCode, 127);
});
