import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];
const version = releaseVersion(tag);
const platform = `${process.platform}-${process.arch}`;
if (!["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].includes(platform)) {
  throw new Error(`Unsupported release platform: ${platform}`);
}
const output = path.resolve(process.argv[3] ?? path.join(root, "release-dist"));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), "bento-package-"));
const directory = path.join(temporary, `bento-${tag}`);
try {
  execFileSync("pnpm", ["--filter", "@bento/tui", "deploy", "--prod", directory], {
    cwd: root,
    stdio: "inherit",
  });
  // pnpm 9 leaves the hoisted self-reference pointing at the original checkout.
  // Make that reference relocatable as well as the package's dependencies.
  const selfLink = path.join(directory, "node_modules/.pnpm/node_modules/@bento/tui");
  await rm(selfLink, { force: true });
  await mkdir(path.dirname(selfLink), { recursive: true });
  await symlink(path.relative(path.dirname(selfLink), directory), selfLink);
  // Ship runtime files only, including the database migrations. Never include
  // workspace source folders or local environment/configuration files.
  const visited = new Set();
  async function pruneWorkspace(directory) {
    directory = await realpath(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const require = createRequire(path.join(directory, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@bento/"))) {
      let dependency = path.dirname(require.resolve(name));
      while (JSON.parse(await readFile(path.join(dependency, "package.json"), "utf8").catch(() => "{}")).name !== name) {
        const parent = path.dirname(dependency);
        if (parent === dependency) throw new Error(`Cannot locate packaged ${name}`);
        dependency = parent;
      }
      await pruneWorkspace(dependency);
    }
    const keep = new Set(["dist", "migrations", "package.json", "node_modules", "LICENSE", "README.md"]);
    for (const entry of await readdir(directory)) {
      if (!keep.has(entry)) await rm(path.join(directory, entry), { recursive: true, force: true });
    }
  }
  await pruneWorkspace(directory);
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  await copyFile(path.join(root, "scripts/bento-launcher.sh"), path.join(directory, "bento"));
  await chmod(path.join(directory, "bento"), 0o755);
  await copyFile(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
  await mkdir(path.join(directory, "sandbox"));
  await copyFile(path.join(root, "infra/sandbox-image/Dockerfile"), path.join(directory, "sandbox/Dockerfile"));
  const asset = `bento-cli-${tag}-${platform}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(output, asset), "-C", temporary, path.basename(directory)]);
  const checksum = createHash("sha256").update(await readFile(path.join(output, asset))).digest("hex");
  await writeFile(path.join(output, `${asset}.sha256`), `${checksum}  ${asset}\n`);
  const installer = (await readFile(path.join(root, "scripts/install.sh"), "utf8"))
    .replace('RELEASE_VERSION=""', `RELEASE_VERSION="${tag}"`);
  await writeFile(path.join(output, "install.sh"), installer, { mode: 0o755 });
  console.log(`Packaged ${asset}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
