import path from "node:path";
import { collectExec, type SandboxDriver, type SandboxHandle } from "@bento/sandbox";

/**
 * Puts files a person chose into a sandbox.
 *
 * Through stdin into a script inside the sandbox, never as a shell
 * argument: a name or a byte a person chose must not reach a command
 * line. Both the card message attachments and a swarm's plan sources
 * go through here, so there is one script to read and one to keep
 * right.
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

export async function writeSandboxFiles(
  driver: SandboxDriver,
  handle: SandboxHandle,
  directory: string,
  files: SandboxFile[],
  options: { overwrite: boolean; timeoutMs?: number } = { overwrite: false },
): Promise<string[]> {
  if (!driver.supportsStdin) throw new Error("This sandbox cannot receive files.");
  const script = `
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const {directory, files, overwrite} = JSON.parse(input);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  for (const file of files) fs.writeFileSync(path.join(directory, file.name), Buffer.from(file.data, 'base64'), {flag: overwrite ? 'w' : 'wx', mode: 0o600});
});`;
  const result = await collectExec(
    driver.exec(handle, ["node", "-e", script], {
      cwd: handle.workdir,
      timeoutMs: options.timeoutMs ?? 30_000,
      stdin: (async function* () {
        yield JSON.stringify({ directory, files, overwrite: options.overwrite });
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
