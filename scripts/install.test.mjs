import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { releaseVersion } from "./release-version.mjs";
import ts from "typescript";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realCurl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim();
const platform = `${process.platform}-${process.arch}`;
let temporary, archive, tag, asset, server, env, installer;
let corruptChecksum = false;
let missingRelease = false;
let requests = [];

before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "bento-install-test-"));
  tag = process.env.BENTO_TEST_ARCHIVE
    ? path.basename(process.env.BENTO_TEST_ARCHIVE).slice("bento-cli-".length, -`-${platform}.tar.gz`.length)
    : "v1.2.3-rc.1";
  releaseVersion(tag);
  asset = `bento-cli-${tag}-${platform}.tar.gz`;
  archive = path.join(temporary, asset);
  if (process.env.BENTO_TEST_ARCHIVE) {
    await copyFile(process.env.BENTO_TEST_ARCHIVE, archive);
  } else {
    const fixture = path.join(temporary, `bento-${tag}`);
    await mkdir(path.join(fixture, "dist"), { recursive: true });
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ name: "@bento/tui", type: "module", version: releaseVersion(tag) }));
    await writeFile(path.join(fixture, "dist/cli.js"), `import {readFileSync} from 'node:fs';
if (process.argv[2] === 'update') {
  try { await (await import('./update.js')).runUpdate(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else console.log(process.argv[2] === '--version' ? JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version : 'Bento usage');\n`);
    const updater = ts.transpileModule(await readFile(path.join(root, "apps/tui/src/update.ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await writeFile(path.join(fixture, "dist/update.js"), updater);
    await copyFile(path.join(root, "scripts/install.sh"), path.join(fixture, "install.sh"));
    await copyFile(path.join(root, "scripts/bento-launcher.sh"), path.join(fixture, "bento"));
    await chmod(path.join(fixture, "bento"), 0o755);
    await execFile("tar", ["-czf", archive, "-C", temporary, `bento-${tag}`]);
  }
  const bytes = await readFile(archive);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  installer = path.join(root, "scripts/install.sh");
  const installScript = await readFile(installer, "utf8");
  server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/domain-install") { response.writeHead(302, { Location: "/install.sh" }); response.end(); }
    else if (request.url === "/latest" && !missingRelease) response.end(JSON.stringify({ tag_name: tag }));
    else if (request.url === "/install.sh") response.end(installScript);
    else if (request.url === `/${tag}/${asset}`) response.end(bytes);
    else if (request.url === `/${tag}/SHA256SUMS`) response.end(`${corruptChecksum ? "0".repeat(64) : checksum}  ${asset}\n`);
    else { response.writeHead(404); response.end("missing release"); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const shims = path.join(temporary, "shims");
  await mkdir(shims);
  // Exercise real curl and HTTP downloads without publishing a test release.
  await writeFile(path.join(shims, "curl"), [
    '#!/usr/bin/env bash',
    'args=()',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    https://usebento.ai/install.sh) arg="$BENTO_TEST_HTTP/domain-install" ;;',
    '    https://api.github.com/repos/danielpang/bento/releases/latest) arg="$BENTO_TEST_HTTP/latest" ;;',
    '    https://github.com/danielpang/bento/releases/download/*) arg="$BENTO_TEST_HTTP/${arg#https://github.com/danielpang/bento/releases/download/}" ;;',
    '  esac',
    '  args+=("$arg")',
    'done',
    'exec "$BENTO_TEST_CURL" "${args[@]}"',
    '',
  ].join("\n"), { mode: 0o755 });
  env = {
    ...process.env,
    BENTO_VERSION: "",
    BENTO_GITHUB_REPO: "danielpang/bento",
    BENTO_INSTALL_DIR: path.join(temporary, "installed CLI"),
    BENTO_BIN_DIR: path.join(temporary, "user bin"),
    BENTO_TEST_HTTP: `http://127.0.0.1:${server.address().port}`,
    BENTO_TEST_CURL: realCurl,
    PATH: `${shims}:${process.env.PATH}`,
  };
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function install(args = [], overrides = {}, script = installer) {
  return execFile("sh", [script, ...args], { env: { ...env, ...overrides }, cwd: temporary, timeout: 120_000 });
}
async function installedVersion() {
  return (await execFile(path.join(env.BENTO_BIN_DIR, "bento"), ["--version"], { cwd: temporary })).stdout.trim();
}

test("version tags reject non-versions and shell/path syntax", () => {
  assert.equal(releaseVersion("v2.3.4"), "2.3.4");
  assert.equal(releaseVersion("v2.3.4-beta.1"), "2.3.4-beta.1");
  for (const invalid of ["latest", "v1", "v01.2.3", "v1.2.3/../../x", "v1.2.3;echo", "v1.2.3-", ""]) {
    assert.throws(() => releaseVersion(invalid));
  }
});

test("latest installation downloads the native archive, verifies it, and runs through a symlink", async () => {
  await execFile("sh", ["-c", "curl -fsSL https://usebento.ai/install.sh | sh"], {
    env, cwd: temporary, timeout: 120_000,
  });
  assert.equal(await installedVersion(), releaseVersion(tag));
  assert.ok(requests.includes("/latest"));
  assert.ok(requests.includes("/domain-install"));
  assert.ok(requests.includes("/install.sh"));
  assert.ok(requests.includes(`/${tag}/${asset}`));
  assert.ok(requests.includes(`/${tag}/SHA256SUMS`));
  assert.deepEqual(JSON.parse(await readFile(path.join(env.BENTO_INSTALL_DIR, ".bento-install.json"), "utf8")), {
    version: 1, binDir: env.BENTO_BIN_DIR,
  });
  const { stdout } = await execFile(path.join(env.BENTO_BIN_DIR, "bento"), ["--help"], { cwd: temporary });
  assert.match(stdout, /bento|Bento/i);
});

test("the installer also runs under dash without Bash extensions", async (t) => {
  try { await execFile("dash", ["-c", "exit 0"]); }
  catch (error) {
    if (error.code === "ENOENT") return t.skip("dash is unavailable on this platform");
    throw error;
  }
  await execFile("dash", [installer, tag], { env, cwd: temporary, timeout: 120_000 });
  assert.equal(await installedVersion(), releaseVersion(tag));
});

test("release installers pin their version and upgrades replace the installation", async () => {
  const pinned = path.join(temporary, "pinned-install.sh");
  await writeFile(pinned, (await readFile(installer, "utf8")).replace('RELEASE_VERSION=""', `RELEASE_VERSION="${tag}"`));
  await writeFile(path.join(env.BENTO_INSTALL_DIR, "obsolete"), "old installation");
  requests = [];
  await install([], {}, pinned);
  assert.equal(await installedVersion(), releaseVersion(tag));
  await assert.rejects(stat(path.join(env.BENTO_INSTALL_DIR, "obsolete")), { code: "ENOENT" });
  assert.ok(!requests.includes("/latest"));
  // A release script still permits an explicit version override.
  await assert.rejects(install(["v99.99.99"], {}, pinned));
  assert.ok(requests.some((url) => url.startsWith("/v99.99.99/")));
  assert.equal(await installedVersion(), releaseVersion(tag));
});

test("checksum failures preserve the working installation", async () => {
  corruptChecksum = true;
  try {
    await assert.rejects(install([tag]), (error) => /checksum verification failed/.test(error.stderr));
    assert.equal(await installedVersion(), releaseVersion(tag));
  } finally { corruptChecksum = false; }
});

test("unsafe destinations and invalid versions fail without replacing the installation", async () => {
  await assert.rejects(install(["../../bad"]), (error) => /Invalid version/.test(error.stderr));
  await assert.rejects(install([tag], { BENTO_INSTALL_DIR: `${temporary}/..` }), (error) => /dedicated directory/.test(error.stderr));
  const unrelated = path.join(temporary, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "preserve this");
  await assert.rejects(install([tag], { BENTO_INSTALL_DIR: unrelated }), (error) => /another application/.test(error.stderr));
  assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "preserve this");
  assert.equal(await installedVersion(), releaseVersion(tag));
});

test("old Node versions and unsupported platforms fail before download", async () => {
  const directory = path.join(temporary, "node-shim");
  await mkdir(directory);
  const shim = path.join(directory, "node");
  await writeFile(shim, `#!/bin/sh\nif [ "$1" = -e ]; then exit 1; fi\necho v20.0.0\n`, { mode: 0o755 });
  requests = [];
  await assert.rejects(install([tag], { PATH: `${directory}:${env.PATH}` }), (error) => /22.19 or newer/.test(error.stderr));
  await writeFile(shim, `#!/bin/sh\nif [ "$1" = -p ]; then echo freebsd-x64; else exec "$BENTO_TEST_NODE" "$@"; fi\n`);
  await assert.rejects(install([tag], { PATH: `${directory}:${env.PATH}`, BENTO_TEST_NODE: process.execPath }), (error) => /Unsupported platform/.test(error.stderr));
  assert.deepEqual(requests, []);
});

async function update(overrides = {}) {
  return execFile(path.join(env.BENTO_BIN_DIR, "bento"), ["update"], {
    cwd: temporary, env: { ...env, ...overrides }, timeout: 120_000,
  });
}

async function setInstalledVersion(version) {
  const filename = path.join(env.BENTO_INSTALL_DIR, "package.json");
  const manifest = JSON.parse(await readFile(filename, "utf8"));
  await writeFile(filename, JSON.stringify({ ...manifest, version }));
}

test("bento update skips downloads when current and ignores leftover installer overrides", async () => {
  requests = [];
  const { stdout } = await update({
    BENTO_VERSION: "v99.99.99", BENTO_INSTALL_DIR: path.join(temporary, "wrong installation"),
    BENTO_BIN_DIR: path.join(temporary, "wrong bin"), BENTO_GITHUB_REPO: "wrong/repo",
  });
  assert.match(stdout, /already up to date/);
  assert.deepEqual(requests, ["/latest"]);
  assert.equal(await installedVersion(), releaseVersion(tag));
});

test("bento update replaces its own installation and keeps custom paths and user data", async () => {
  await setInstalledVersion("0.0.0");
  const obsolete = path.join(env.BENTO_INSTALL_DIR, "old-file");
  await writeFile(obsolete, "old installation");
  const userData = path.join(temporary, "user data");
  await mkdir(userData);
  await writeFile(path.join(userData, "settings.json"), '{"keep":true}');
  const { stdout } = await update({ BENTO_DATA_DIR: userData });
  assert.equal(await installedVersion(), releaseVersion(tag));
  assert.match(stdout, /Restart Bento/);
  assert.match(stdout, /docker build/);
  assert.equal(await readFile(path.join(userData, "settings.json"), "utf8"), '{"keep":true}');
  await assert.rejects(stat(obsolete), { code: "ENOENT" });
  assert.equal(await realpath(path.join(env.BENTO_BIN_DIR, "bento")), await realpath(path.join(env.BENTO_INSTALL_DIR, "bento")));
  assert.match((await update()).stdout, /already up to date/);
});

test("bento update preserves the installed CLI when checksum verification fails", async () => {
  await setInstalledVersion("0.0.0");
  corruptChecksum = true;
  try {
    await assert.rejects(update(), (error) => /checksum verification failed/.test(error.stderr));
    assert.equal(await installedVersion(), "0.0.0");
  } finally {
    corruptChecksum = false;
    await setInstalledVersion(releaseVersion(tag));
  }
});

test("bento update handles unpublished or unavailable releases without replacing the CLI", async () => {
  missingRelease = true;
  try {
    await assert.rejects(update(), (error) => /Could not resolve the latest release/.test(error.stderr));
    assert.equal(await installedVersion(), releaseVersion(tag));
  } finally { missingRelease = false; }
});

test("bento update refuses source and unmanaged installations before any download", async () => {
  const marker = path.join(env.BENTO_INSTALL_DIR, ".bento-install.json");
  const metadata = await readFile(marker);
  await rm(marker);
  requests = [];
  try {
    await assert.rejects(update(), (error) => /source checkout.*Git/.test(error.stderr));
    assert.deepEqual(requests, []);
    assert.equal(await installedVersion(), releaseVersion(tag));
  } finally { await writeFile(marker, metadata); }
});

test("real release includes native rendering, embedded server and migrations without workspace links", {
  skip: !process.env.BENTO_TEST_ARCHIVE,
}, async () => {
  assert.match(await readFile(path.join(env.BENTO_INSTALL_DIR, "sandbox/Dockerfile"), "utf8"), /^FROM /m);
  const { stdout } = await execFile(process.execPath, ["--input-type=module", "-e", `
    import sharp from 'sharp';
    import { createRequire } from 'node:module';
    import { readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { startServer } from '@bento/server';
    const require = createRequire(import.meta.resolve('@bento/server'));
    const journal = path.join(path.dirname(require.resolve('@bento/db')), '../migrations/meta/_journal.json');
    if (!JSON.parse(await readFile(journal, 'utf8')).entries.length) throw Error('Missing migrations');
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#00aaff' } }).png().toBuffer();
    if (!png.length || typeof startServer !== 'function') throw Error('Broken runtime');
    console.log('Packaged runtime works');
  `], { cwd: env.BENTO_INSTALL_DIR });
  assert.match(stdout, /Packaged runtime works/);
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(directory, await readlink(filename));
        assert.ok(target === env.BENTO_INSTALL_DIR || target.startsWith(`${env.BENTO_INSTALL_DIR}/`), `External package link: ${filename}`);
      } else if (entry.isDirectory()) await inspect(filename);
    }
  }
  await inspect(env.BENTO_INSTALL_DIR);
});
