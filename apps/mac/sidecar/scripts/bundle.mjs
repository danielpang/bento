// Builds dist/: one ESM file runnable with plain `node`, plus the files it
// reads at runtime beside it. Workspace packages are bundled from their
// built dist, so build them first (see the README).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "../../..");
const dist = path.join(root, "dist");
const arch = process.env.BENTO_SIDECAR_ARCH ?? process.arch;

await fs.rm(dist, { recursive: true, force: true });

// migrate.ts runs itself when it is the entry script, and in a bundle
// every module shares the entry's import.meta.url.
const noSelfRun = {
  name: "no-self-run",
  setup(b) {
    b.onLoad({ filter: /packages[\\/]db[\\/]dist[\\/]migrate\.js$/ }, async (args) => {
      const source = await fs.readFile(args.path, "utf8");
      const guarded = source.replace(/if \(process\.argv\[1\] && /, "if (false && ");
      if (guarded === source) throw new Error("migrate.js no longer has the self-run guard this build disables");
      return { contents: guarded, loader: "js" };
    });
  },
};

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(dist, "bin/sidecar.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // CommonJS dependencies call require() for node builtins and read __dirname.
  banner: {
    js: [
      "import { createRequire as __bentoCreateRequire } from 'node:module';",
      "import { fileURLToPath as __bentoFileURLToPath } from 'node:url';",
      "const require = __bentoCreateRequire(import.meta.url);",
      "const __filename = __bentoFileURLToPath(import.meta.url);",
      "const __dirname = __bentoFileURLToPath(new URL('.', import.meta.url));",
    ].join(" "),
  },
  external: ["@embedded-postgres/*", "pg-native", "cpu-features", "*.node"],
  plugins: [noSelfRun],
  legalComments: "none",
  logLevel: "warning",
});

// packages/db resolves its migrations as <module dir>/../migrations.
await fs.cp(path.join(repo, "packages/db/migrations"), path.join(dist, "migrations"), { recursive: true });
await fs.mkdir(path.join(dist, "sandbox"), { recursive: true });
await fs.cp(path.join(repo, "infra/sandbox-image/Dockerfile"), path.join(dist, "sandbox/Dockerfile"));
const webDist = path.join(repo, "apps/web/dist");
if (await fs.access(webDist).then(() => true, () => false)) {
  await fs.cp(webDist, path.join(dist, "web"), { recursive: true, filter: (file) => !file.endsWith(".map") });
}

await copyPostgres(path.join(dist, "postgres"));

async function copyPostgres(target) {
  const serverRequire = createRequire(path.join(repo, "apps/server/package.json"));
  const pkg = `@embedded-postgres/${process.platform}-${arch}`;
  const native = path.resolve(path.dirname(serverRequire.resolve(pkg)), "..", "native");
  await fs.cp(native, target, { recursive: true, dereference: true, filter: (f) => !f.endsWith("pg-symlinks.json") });
  if (process.platform !== "darwin") return;
  // The package ships universal binaries and every library alias as a
  // full copy. Keep one architecture, and one copy behind symlinks.
  for (const file of await walk(target)) {
    const archs = tryRun("lipo", ["-archs", file]);
    if (archs && archs.split(/\s+/).length > 1) execFileSync("lipo", [file, "-thin", arch === "x64" ? "x86_64" : arch, "-output", file]);
  }
  const lib = path.join(target, "lib");
  const groups = new Map();
  for (const name of await fs.readdir(lib)) {
    const file = path.join(lib, name);
    if (!(await fs.lstat(file)).isFile()) continue;
    const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    groups.set(hash, [...(groups.get(hash) ?? []), name]);
  }
  for (const names of groups.values()) {
    const [keep, ...aliases] = names.sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      await fs.rm(path.join(lib, alias));
      await fs.symlink(keep, path.join(lib, alias));
    }
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(file)));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
