import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Run the bundled, checksum-verifying installer without starting the local stack. */
export async function runUpdate(installationRoot = fileURLToPath(new URL("../", import.meta.url))): Promise<void> {
  const root = await realpath(installationRoot);
  const installer = path.join(root, "install.sh");
  let binDir: string;
  try {
    const metadata = JSON.parse(await readFile(path.join(root, ".bento-install.json"), "utf8"));
    if (metadata.version !== 1 || typeof metadata.binDir !== "string" || !path.isAbsolute(metadata.binDir)) {
      throw new Error("Invalid installation metadata");
    }
    binDir = metadata.binDir;
    await access(installer, constants.R_OK);
    // Never replace a command that now points at another installation or application.
    if (await realpath(path.join(binDir, "bento")) !== await realpath(path.join(root, "bento"))) {
      throw new Error("The installed command has moved");
    }
  } catch {
    throw new Error(
      "Use a release installed with Bento's install.sh to run bento update. " +
      "For a source checkout, pull updates with Git, run pnpm install, then restart ./scripts/dev-cli.sh.",
    );
  }
  try {
    await access(path.dirname(root), constants.W_OK);
    await access(binDir, constants.W_OK);
  } catch {
    throw new Error("The installation is not writable. Reinstall Bento in a user-owned directory.");
  }

  console.log("Checking for the latest stable Bento release...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", [installer], {
      cwd: path.dirname(root),
      stdio: "inherit",
      env: {
        ...process.env,
        // Updating always targets this installation and the official stable release,
        // regardless of overrides left over from a previous install command.
        BENTO_INSTALL_DIR: root,
        BENTO_BIN_DIR: binDir,
        BENTO_GITHUB_REPO: "danielpang/bento",
        BENTO_VERSION: "",
        BENTO_UPDATE: "1",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `Installer stopped (${signal}).` : `Installer exited with code ${code}. See the message above.`));
    });
  });
}
