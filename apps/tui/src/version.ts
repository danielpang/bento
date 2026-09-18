import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A release reports its stamped tag; a source checkout reports its Git revision. */
export function cliVersion(moduleUrl: string): string {
  const packageDirectory = path.resolve(fileURLToPath(new URL("../", moduleUrl)));
  const checkout = path.resolve(packageDirectory, "../..");
  if (packageDirectory === path.join(checkout, "apps", "tui") && existsSync(path.join(checkout, ".git"))) {
    try {
      return execFileSync("git", [
        "-C", checkout, "describe", "--tags", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--always", "--dirty",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // Source archives may have no Git metadata or executable Git.
    }
  }

  const manifest = createRequire(moduleUrl)("../package.json") as { version: string };
  return `v${manifest.version}`;
}
