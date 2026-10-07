import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * The operating system's own folder dialog, opened by the server.
 *
 * A browser page cannot learn a folder's path: the file input hands it
 * the files and never where they live, and a project needs the path.
 * In local mode the server is a process on the same machine as the
 * person at the console, so it can ask the OS for a folder on their
 * behalf. The Mac app has its own native picker and does not use this.
 *
 * Local mode only, and never in a container: there is no screen there
 * to put a dialog on, so the console hides the button instead.
 */

export interface PickerCommand {
  command: string;
  args: string[];
}

/** What a pick answers with: a path, or null when the dialog was cancelled. */
export type PickRunner = (cmd: PickerCommand) => Promise<{ stdout: string; cancelled: boolean }>;

const PROMPT = "Choose a repository";

/** The dialog for this platform, or null when there is none to show. */
export async function folderPickerCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  onPath: (binary: string) => Promise<boolean> = binaryOnPath,
): Promise<PickerCommand | null> {
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", `POSIX path of (choose folder with prompt "${PROMPT}")`] };
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.Description = '${PROMPT}'`,
      "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath } else { exit 1 }",
    ].join("; ");
    return { command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] };
  }
  if (platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    if (await onPath("zenity")) {
      return { command: "zenity", args: ["--file-selection", "--directory", `--title=${PROMPT}`] };
    }
    if (await onPath("kdialog")) {
      return { command: "kdialog", args: ["--getexistingdirectory", ".", "--title", PROMPT] };
    }
  }
  return null;
}

async function binaryOnPath(binary: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      await access(path.join(dir, binary));
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

/**
 * Whether a dialog that exited non-zero was cancelled rather than broken.
 *
 * Every dialog exits 1 on a cancel, which is an answer rather than a
 * failure: zenity, kdialog and the PowerShell script say nothing, and
 * osascript prints "User canceled. (-128)". A failure can exit 1 too
 * (osascript does for any script error), so the exit code alone is not
 * enough: exit 1 is a cancel only when stderr is empty or names one.
 * Anything else is thrown so the console can say what went wrong.
 */
export function isPickerCancel(code: unknown, stderr: string): boolean {
  if (code !== 1) return false;
  const text = stderr.trim();
  return text === "" || /-128\b|user cancel/i.test(text);
}

export const runPicker: PickRunner = (cmd) =>
  new Promise((resolve, reject) => {
    // Generous: the person is browsing, not the machine.
    execFile(cmd.command, cmd.args, { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, cancelled: false });
      const text = `${stderr}`;
      if (isPickerCancel((error as { code?: unknown }).code, text)) {
        return resolve({ stdout: "", cancelled: true });
      }
      reject(new Error(text.trim() || error.message));
    });
  });

/** A chosen path as the dialog printed it, without the trailing newline or slash. */
export function cleanPickedPath(stdout: string): string | null {
  const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!line) return null;
  return line.length > 1 ? line.replace(/[\\/]+$/, "") : line;
}
