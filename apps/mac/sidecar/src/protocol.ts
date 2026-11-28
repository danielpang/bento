/** One line of the sidecar's stdout. Nothing else is ever written there. */
export type SidecarEvent =
  | { event: "progress"; message: string }
  | { event: "ready"; url: string; port: number; databasePort: number | null; sandbox: string }
  | { event: "error"; message: string }
  | { event: "stopping"; reason: string }
  | { event: "stopped"; code: number };

/**
 * Takes stdout for the protocol and points everything else that would
 * write there (console.log, a library's process.stdout.write) at stderr.
 * Call before anything else logs.
 */
export function claimStdout(): (event: SidecarEvent) => void {
  const write = process.stdout.write.bind(process.stdout);
  const toStderr = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  process.stdout.write = toStderr;
  // A parent that died leaves broken pipes; a write to one must not become an uncaught exception.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  for (const method of ["log", "info", "debug"] as const) console[method] = console.error;
  return (event) => {
    write(`${JSON.stringify(event)}\n`);
  };
}
