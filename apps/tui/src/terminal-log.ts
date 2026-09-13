import { Console } from "node:console";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

/** Background server output must not move the full-screen UI's mouse origin. */
export async function redirectTerminalLogs(dataDir: string): Promise<() => Promise<void>> {
  const directory = path.join(dataDir, "logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(path.join(directory, "tui.log"), "a", 0o600);
  const stream = file.createWriteStream();
  const previous = globalThis.console;
  // React also uses inspector methods such as timeStamp, which a new Console
  // instance does not provide. Preserve those from Node's original console.
  globalThis.console = Object.assign(Object.create(previous), new Console({ stdout: stream, stderr: stream }));
  return async () => {
    globalThis.console = previous;
    await new Promise<void>((resolve) => {
      stream.once("close", resolve);
      stream.end();
    });
  };
}
