import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-uninstall-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "installed CLI");
  const bin = path.join(temporary, "user bin");
  const data = path.join(temporary, "user data");
  await Promise.all([root, bin, data].map((directory) => mkdir(directory)));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@bento/tui" }));
  await writeFile(path.join(root, ".bento-install.json"), JSON.stringify({ version: 1, binDir: bin }));
  await writeFile(path.join(root, "bento"), "CLI");
  await symlink(path.join(root, "bento"), path.join(bin, "bento"));
  await writeFile(path.join(data, "credentials.json"), '{"keep":true}');
  await writeFile(path.join(bin, "another-command"), "keep");
  return { temporary, root, bin, data };
}

function uninstall(root: string, answer: string, beforeAnswer?: () => Promise<void>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { runUninstall } from ${JSON.stringify(new URL("./uninstall.ts", import.meta.url).href)};
      try { await runUninstall(process.argv[1]); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `, root], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      // Stale installer overrides must never redirect what gets removed.
      env: { ...process.env, BENTO_INSTALL_DIR: "/wrong-install", BENTO_BIN_DIR: "/wrong-bin" },
      stdio: "pipe",
      timeout: 15_000,
    });
    let stdout = "", stderr = "", prompted = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!prompted && stdout.includes("Type Y and press Enter")) {
        prompted = true;
        Promise.resolve().then(beforeAnswer).then(() => child.stdin.end(answer)).catch((error) => {
          child.kill();
          reject(error);
        });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Y removes the managed CLI and symlink while preserving user data and sibling commands", async (t) => {
  const { root, bin, data } = await fixture(t);
  const result = await uninstall(root, "Y\n", async () => {
    assert.ok((await lstat(root)).isDirectory(), "installation survives until confirmation");
    assert.ok((await lstat(path.join(bin, "bento"))).isSymbolicLink());
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(root));
  assert.ok(result.stdout.includes(path.join(bin, "bento")));
  assert.match(result.stdout, /Bento CLI uninstalled/);
  await assert.rejects(lstat(root), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(bin, "bento")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(data, "credentials.json"), "utf8"), '{"keep":true}');
  assert.equal(await readFile(path.join(bin, "another-command"), "utf8"), "keep");
});

for (const answer of ["\n", "N\n", "y\n", "yes\n", ""]) {
  test(`only uppercase Y confirms; ${JSON.stringify(answer)} cancels`, async (t) => {
    const { root, bin } = await fixture(t);
    const result = await uninstall(root, answer);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Uninstall cancelled/);
    assert.ok((await lstat(root)).isDirectory());
    assert.ok((await lstat(path.join(bin, "bento"))).isSymbolicLink());
  });
}

test("source and unmanaged installations are refused before prompting", async (t) => {
  const { root } = await fixture(t);
  await unlink(path.join(root, ".bento-install.json"));
  const result = await uninstall(root, "Y\n");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot verify/);
  assert.doesNotMatch(result.stdout, /Type Y/);
  assert.ok((await lstat(root)).isDirectory());
});

test("a command redirected to another application is preserved", async (t) => {
  const { root, bin } = await fixture(t);
  await unlink(path.join(bin, "bento"));
  await symlink(path.join(bin, "another-command"), path.join(bin, "bento"));
  const result = await uninstall(root, "Y\n");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot verify/);
  assert.ok((await lstat(root)).isDirectory());
  assert.equal(await readFile(path.join(bin, "bento"), "utf8"), "keep");
});

test("rechecks the command after confirmation before removing anything", async (t) => {
  const { root, bin } = await fixture(t);
  const result = await uninstall(root, "Y\n", async () => {
    await unlink(path.join(bin, "bento"));
    await writeFile(path.join(bin, "bento"), "replacement command");
  });
  assert.equal(result.code, 1);
  assert.ok((await lstat(root)).isDirectory());
  assert.equal(await readFile(path.join(bin, "bento"), "utf8"), "replacement command");
});

test("invalid metadata and unrelated package manifests are refused", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "another-app" }));
  assert.equal((await uninstall(root, "Y\n")).code, 1);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@bento/tui" }));
  await writeFile(path.join(root, ".bento-install.json"), '{"version":1,"binDir":"relative"}');
  assert.equal((await uninstall(root, "Y\n")).code, 1);
  assert.ok((await lstat(root)).isDirectory());
});
