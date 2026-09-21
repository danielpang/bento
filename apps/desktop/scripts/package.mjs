import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseVersion } from "../../../scripts/release-version.mjs";

if (process.platform !== "darwin") throw new Error("Build the macOS application on a Mac.");
const root = path.resolve(import.meta.dirname, "..");
const repository = path.resolve(root, "../..");
const sourceManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
// Releases use the same tag as package-cli.mjs. Local builds identify the
// checkout, including commits since the tag and uncommitted changes.
let tag = process.env.BENTO_RELEASE_TAG;
if (!tag) {
  try {
    tag = execFileSync("git", ["describe", "--tags", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--dirty"], {
      cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    tag = `v${sourceManifest.version}-dev`;
  }
}
const version = releaseVersion(tag);
const supplied = process.argv.slice(2);
const unsigned = supplied.includes("--unsigned");
// Build beside a running app when verifying a new desktop release. Replacing
// its resources would leave the old main process using new renderer assets.
const output = path.resolve(repository, process.env.BENTO_DESKTOP_OUTPUT ?? "release-dist/desktop");
const temporary = await mkdtemp(path.join(os.tmpdir(), "bento-desktop-package-"));
const stage = path.join(temporary, "app");
try {
  execFileSync("pnpm", ["--filter", "@bento/desktop", "deploy", "--prod", stage], { cwd: repository, stdio: "inherit" });
  const selfLink = path.join(stage, "node_modules/.pnpm/node_modules/@bento/desktop");
  await rm(selfLink, { force: true });
  await mkdir(path.dirname(selfLink), { recursive: true });
  await symlink(path.relative(path.dirname(selfLink), stage), selfLink);
  const visited = new Set();
  async function pruneWorkspace(directory) {
    directory = await realpath(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const require = createRequire(path.join(directory, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith("@bento/"))) {
      let dependency = path.dirname(require.resolve(name));
      while (JSON.parse(await readFile(path.join(dependency, "package.json"), "utf8").catch(() => "{}")).name !== name) {
        const parent = path.dirname(dependency);
        if (parent === dependency) throw new Error(`Cannot locate packaged ${name}`);
        dependency = parent;
      }
      await pruneWorkspace(dependency);
    }
    const keep = new Set(["dist", "assets", "migrations", "package.json", "node_modules", "LICENSE", "README.md"]);
    for (const entry of await readdir(directory)) {
      if (!keep.has(entry)) await rm(path.join(directory, entry), { recursive: true, force: true });
    }
  }
  await pruneWorkspace(stage);
  await cp(path.join(root, "electron-builder.yml"), path.join(stage, "electron-builder.yml"));
  await cp(path.join(root, "entitlements.mac.plist"), path.join(stage, "entitlements.mac.plist"));
  const manifestFile = path.join(stage, "package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.devDependencies;
  manifest.version = version;
  // Only explicitly versioned, signed release packages may contact the feed.
  manifest.bentoUpdatesEnabled = Boolean(process.env.BENTO_RELEASE_TAG && !unsigned);
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  const args = ["exec", "electron-builder", "--projectDir", stage, "--config", path.join(stage, "electron-builder.yml"),
    `--config.electronVersion=${sourceManifest.devDependencies.electron}`,
    `--config.directories.output=${output}`];
  if (unsigned) args.push("--config.mac.identity=null", "--config.mac.notarize=false", "--config.forceCodeSigning=false");
  args.push(...supplied.filter(arg => arg !== "--unsigned"));
  if (!supplied.some(arg => arg === "--arm64" || arg === "--x64" || arg === "--universal")) args.push(`--${process.arch}`);
  // Release publication is atomic and owned by release.yml, never builder.
  args.push("--publish", "never");
  execFileSync("pnpm", args, { cwd: root, stdio: "inherit", env: { ...process.env, ...(unsigned ? { CSC_IDENTITY_AUTO_DISCOVERY: "false" } : {}) } });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
