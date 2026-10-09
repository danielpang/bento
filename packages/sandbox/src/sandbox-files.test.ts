import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalProcessDriver } from "./local-process.js";
import { sandboxFileExists, writeSandboxFiles } from "./sandbox-files.js";

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), "bento-files-"));
  const driver = new LocalProcessDriver();
  const handle = await driver.provision({ projectId: "p", workspaceKey: "f", hostWorkspacePath: dir });
  return { dir, driver, handle };
}

test("files larger than a pipe buffer arrive byte for byte, private to the owner", async () => {
  const { dir, driver, handle } = await workspace();
  // The swarm that hung handed over about 50KB of plan, 67KB as base64:
  // past the 64KB a pipe holds, so the script has to read as it goes.
  const big = randomBytes(96 * 1024);
  const small = Buffer.from("<p>hub</p>\n", "utf8");
  const target = path.join(dir, ".bento", "plan");
  const written = await writeSandboxFiles(
    driver,
    handle,
    target,
    [
      { name: "1-index.html", data: small.toString("base64") },
      { name: "2-hub.bin", data: big.toString("base64") },
    ],
    { overwrite: true },
  );
  assert.deepEqual(written, [path.join(target, "1-index.html"), path.join(target, "2-hub.bin")]);
  assert.deepEqual(await readFile(path.join(target, "1-index.html")), small);
  assert.deepEqual(await readFile(path.join(target, "2-hub.bin")), big);
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(target, "2-hub.bin"))).mode & 0o777, 0o600);
  assert.equal(await sandboxFileExists(driver, handle, path.join(target, "1-index.html")), true);
  assert.equal(await sandboxFileExists(driver, handle, path.join(target, "missing")), false);
});

test("create refuses a file that is already there, overwrite replaces it", async () => {
  const { dir, driver, handle } = await workspace();
  const first = [{ name: "a.txt", data: Buffer.from("one").toString("base64") }];
  const second = [{ name: "a.txt", data: Buffer.from("two").toString("base64") }];
  await writeSandboxFiles(driver, handle, dir, first, { overwrite: false });
  await assert.rejects(writeSandboxFiles(driver, handle, dir, second, { overwrite: false }), /could not be written/);
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one");
  await writeSandboxFiles(driver, handle, dir, second, { overwrite: true });
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "two");
});

test("a name is only ever a word in the script, and a path or line break is refused", async () => {
  const { dir, driver, handle } = await workspace();
  const odd = "$(touch pwned) ; `id` 'q\" *";
  await writeSandboxFiles(driver, handle, dir, [{ name: odd, data: Buffer.from("x").toString("base64") }], {
    overwrite: false,
  });
  assert.equal(await readFile(path.join(dir, odd), "utf8"), "x");
  await assert.rejects(stat(path.join(dir, "pwned")));
  for (const name of ["../escape", "a/b", "line\nbreak", "", ".."]) {
    await assert.rejects(writeSandboxFiles(driver, handle, dir, [{ name, data: "" }], { overwrite: true }));
  }
});
