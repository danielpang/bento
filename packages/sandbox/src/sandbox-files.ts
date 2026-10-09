import path from "node:path";
import { collectExec, type SandboxDriver, type SandboxHandle } from "./driver.js";

/**
 * Puts files a person chose into a sandbox.
 *
 * Through stdin into a script inside the sandbox, never as a shell
 * argument: a name or a byte a person chose must not reach a command
 * line. Both the card message attachments and a swarm's plan sources
 * go through here, so there is one script to read and one to keep
 * right.
 *
 * The script is POSIX sh and coreutils base64, because that is all
 * every sandbox image is guaranteed to carry. It once ran `node -e`,
 * and neither the Modal toolchain image nor the Docker sandbox image
 * puts a node on the PATH (agent-toolchain.ts keeps its private one
 * off it on purpose). On Modal the command was missing, the feeder
 * that writes its stdin had no reader, and a plan larger than the
 * pipe buffer wedged the write: every swarm run there hung before its
 * agent started.
 *
 * The directory is made if it is missing. `overwrite` says whether a
 * file that is already there is an error (an attachment directory is
 * fresh per message and a collision is a bug) or expected (a plan is
 * copied again on every run on the same machine).
 */
export interface SandboxFile {
  /** The name inside the directory. Already made safe by the caller. */
  name: string;
  /** The bytes, as base64. */
  data: string;
}

/**
 * Reads, one line each: the directory, "overwrite" or "create", then a
 * name and its base64 for every file. Every value is quoted where it
 * is used, so a name is only ever a word, never shell. Under `set -C`
 * a redirect onto an existing file fails, which is what "create" asks.
 */
const WRITE_FILES_SCRIPT = `set -eu
umask 077
IFS= read -r directory
IFS= read -r mode
mkdir -p "$directory"
if [ "$mode" != overwrite ]; then set -C; fi
while IFS= read -r name; do
  IFS= read -r data
  printf '%s' "$data" | base64 -d > "$directory/$name"
done`;

export async function writeSandboxFiles(
  driver: SandboxDriver,
  handle: SandboxHandle,
  directory: string,
  files: SandboxFile[],
  options: { overwrite: boolean; timeoutMs?: number } = { overwrite: false },
): Promise<string[]> {
  if (!driver.supportsStdin) throw new Error("This sandbox cannot receive files.");
  for (const value of [directory, ...files.map((file) => file.name)]) {
    if (value.includes("\n")) throw new Error("A file name cannot hold a line break.");
  }
  for (const file of files) {
    if (!file.name || file.name.includes("/") || file.name === "." || file.name === "..") {
      throw new Error(`"${file.name}" is not a file name.`);
    }
  }
  const lines = [directory, options.overwrite ? "overwrite" : "create", ...files.flatMap((file) => [file.name, file.data])];
  const result = await collectExec(
    driver.exec(handle, ["sh", "-c", WRITE_FILES_SCRIPT], {
      cwd: handle.workdir,
      timeoutMs: options.timeoutMs ?? 30_000,
      stdin: (async function* () {
        yield* lines;
      })(),
    }),
  );
  if (result.exitCode !== 0) {
    throw new Error(`the files could not be written into the workspace: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  }
  return files.map((file) => path.posix.join(directory, file.name));
}

/** Whether a file exists in the sandbox, asked without a shell. */
export async function sandboxFileExists(driver: SandboxDriver, handle: SandboxHandle, file: string): Promise<boolean> {
  const result = await collectExec(driver.exec(handle, ["test", "-f", file], { cwd: handle.workdir, timeoutMs: 15_000 }));
  return result.exitCode === 0;
}
