import { constants } from "node:fs";
import { access, lstat, readFile, realpath, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

async function installation(root: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const metadata = JSON.parse(await readFile(path.join(root, ".bento-install.json"), "utf8"));
    if (manifest.name !== "@bento/tui" || metadata.version !== 1 ||
        typeof metadata.binDir !== "string" || !path.isAbsolute(metadata.binDir)) {
      throw new Error("Invalid installation metadata");
    }
    const binDir = await realpath(metadata.binDir);
    const protectedPaths = [path.parse(root).root, os.homedir(), "/usr", "/usr/local", "/usr/local/lib", binDir];
    if (protectedPaths.includes(root) || binDir.startsWith(`${root}${path.sep}`)) {
      throw new Error("Unsafe installation directory");
    }
    const command = path.join(binDir, "bento");
    if (!(await lstat(command)).isSymbolicLink() ||
        await realpath(command) !== path.join(root, "bento") ||
        !(await lstat(path.join(root, "bento"))).isFile()) {
      throw new Error("The installed command has moved");
    }
    return command;
  } catch {
    throw new Error(
      "Cannot verify this CLI installation. Use bento uninstall from a release installed with Bento's install.sh. " +
      "Source checkouts and moved or unmanaged installations must be removed manually.",
    );
  }
}

function confirm(): Promise<boolean> {
  return new Promise((resolve) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    // EOF and Ctrl+C cancel too, including when stdin is redirected or closed.
    readline.once("close", () => resolve(false));
    readline.once("SIGINT", () => readline.close());
    readline.question("Type Y and press Enter to uninstall Bento: ", (answer) => {
      resolve(answer.trim() === "Y");
      readline.close();
    });
  });
}

/** Remove only the managed CLI and its command, without starting the local stack. */
export async function runUninstall(installationRoot = fileURLToPath(new URL("../", import.meta.url))): Promise<void> {
  const root = await realpath(installationRoot);
  const command = await installation(root);
  try {
    await access(path.dirname(root), constants.W_OK);
    await access(root, constants.W_OK);
    await access(path.dirname(command), constants.W_OK);
  } catch {
    throw new Error("The installation is not writable. Remove it using the account that installed Bento.");
  }

  console.log(`This will remove:\n  ${root}\n  ${command}`);
  console.log("Your projects, settings, and credentials will be kept. Quit other Bento sessions before continuing.");
  if (!await confirm()) {
    console.log("Uninstall cancelled.");
    return;
  }

  // The user may have changed the installation while the prompt was open.
  if (await realpath(installationRoot) !== root || await installation(root) !== command) {
    throw new Error("The installation changed during confirmation. Run bento uninstall again.");
  }
  await unlink(command);
  await rm(root, { recursive: true });
  console.log("Bento CLI uninstalled. Your projects, settings, and credentials were kept.");
}
