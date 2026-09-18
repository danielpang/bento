import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cliVersion } from "./version.js";

test("a source checkout reports its tag, commit, and dirty state", async () => {
  const checkout = await mkdtemp(path.join(tmpdir(), "bento-version-"));
  try {
    const tui = path.join(checkout, "apps", "tui");
    await mkdir(path.join(tui, "dist"), { recursive: true });
    await writeFile(path.join(tui, "package.json"), '{"version":"0.0.1"}');
    await writeFile(path.join(checkout, "README.md"), "first\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Bento Test", "-c", "user.email=test@example.com", "commit", "-qm", "first");
    git("tag", "v1.2.3");
    const moduleUrl = pathToFileURL(path.join(tui, "dist", "cli.js")).href;
    assert.equal(cliVersion(moduleUrl), "v1.2.3");

    await writeFile(path.join(checkout, "README.md"), "second\n");
    git("add", ".");
    git("-c", "user.name=Bento Test", "-c", "user.email=test@example.com", "commit", "-qm", "second");
    assert.match(cliVersion(moduleUrl), /^v1\.2\.3-1-g[0-9a-f]+$/);
    await writeFile(path.join(checkout, "README.md"), "dirty\n");
    assert.match(cliVersion(moduleUrl), /^v1\.2\.3-1-g[0-9a-f]+-dirty$/);
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("an installed release reports its stamped tag without Git", async () => {
  const install = await mkdtemp(path.join(tmpdir(), "bento-version-install-"));
  try {
    await writeFile(path.join(install, "package.json"), '{"version":"2.3.4"}');
    const moduleUrl = pathToFileURL(path.join(install, "dist", "cli.js")).href;
    assert.equal(cliVersion(moduleUrl), "v2.3.4");
    assert.equal(JSON.parse(await readFile(path.join(install, "package.json"), "utf8")).version, "2.3.4");
  } finally {
    await rm(install, { recursive: true, force: true });
  }
});
