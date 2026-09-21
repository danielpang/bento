import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
for (const name of ["preload", "launcher-preload"]) {
  await build({ entryPoints: [path.join(root, `src/${name}.ts`)], outfile: path.join(dist, `${name}.cjs`),
    bundle: true, platform: "node", format: "cjs", external: ["electron"], target: "node22" });
}
await mkdir(path.join(dist, "launcher"), { recursive: true });
await cp(path.join(root, "src/launcher"), path.join(dist, "launcher"), { recursive: true });
await cp(path.join(root, "../web/public/apple-touch-icon.png"), path.join(dist, "launcher/icon.png"));
await build({ entryPoints: [path.join(root, "src/launcher.ts")], outfile: path.join(dist, "launcher/launcher.js"),
  bundle: true, platform: "browser", format: "esm", target: "chrome140" });
await rm(path.join(dist, "web"), { recursive: true, force: true });
await cp(path.join(root, "../web/dist"), path.join(dist, "web"), { recursive: true, filter: (file) => !file.endsWith(".map") });
await mkdir(path.join(dist, "sandbox"), { recursive: true });
await cp(path.join(root, "../../infra/sandbox-image/Dockerfile"), path.join(dist, "sandbox/Dockerfile"));
