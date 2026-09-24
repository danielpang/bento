import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { ensureLocalPostgres, startServer, type RunningServer } from "@bento/server";
import { createDockerClient } from "@bento/sandbox";
import type { RuntimeCommand, RuntimeEvent } from "./contracts.js";
import { parseBuildStep, sandboxProgressMessage } from "./sandbox-progress.js";

const parent = process.parentPort;
if (!parent) throw new Error("The Bento runtime must be started by the desktop application.");
const send = (event: RuntimeEvent) => parent.postMessage(event);
let server: RunningServer | undefined;
let listener: Server | undefined;
let starting: Promise<void> | undefined;
let stopping = false;

async function start(command: Extract<RuntimeCommand, { type: "start" }>): Promise<void> {
  const { settings } = command;
  await mkdir(settings.dataDir, { recursive: true });
  if (settings.sandbox === "docker") {
    const docker = createDockerClient();
    try { await docker.ping(); }
    catch { throw new Error("Start Docker Desktop or OrbStack, then try again. Local agents use Docker sandboxes."); }
    if (stopping) return;
    const images = await docker.listImages({ filters: { reference: [settings.sandboxImage] } });
    if (!images.length) {
      // One step installs every agent CLI and runs for minutes, so the
      // elapsed time ticks on its own to show the build has not stalled.
      const began = Date.now();
      let current: ReturnType<typeof parseBuildStep> = null;
      const report = () => send({ type: "progress", message: sandboxProgressMessage(current, Date.now() - began) });
      report();
      const ticker = setInterval(report, 5_000);
      try {
        const stream = await docker.buildImage({ context: command.sandboxDirectory, src: ["Dockerfile"] }, { t: settings.sandboxImage });
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(
            stream,
            (error) => error ? reject(error) : resolve(),
            (event: { stream?: string }) => {
              const step = parseBuildStep(event);
              if (step) { current = step; report(); }
            },
          );
        });
      } finally {
        clearInterval(ticker);
      }
    }
  }
  if (stopping) return;
  if (settings.mode === "local") {
    send({ type: "progress", message: "Starting the local database. On first launch this includes a download." });
    const databaseUrl = settings.databaseUrl || (await ensureLocalPostgres()).databaseUrl;
    if (stopping) return;
    send({ type: "progress", message: "Almost there. Setting up the database and starting Bento..." });
    // Keep the origin stable across restarts, so Chromium retains appearance,
    // project selection, and board preferences. Reserve it before startup to
    // avoid a port race and give OAuth/MCP the right origin from the beginning.
    const portFile = path.join(settings.dataDir, "desktop-port");
    const savedPort = Number(await readFile(portFile, "utf8").catch(() => "0"));
    listener = createServer();
    const bind = (port: number) => new Promise<void>((resolve, reject) => {
      listener!.once("error", reject);
      listener!.listen(port, "127.0.0.1", () => { listener!.off("error", reject); resolve(); });
    });
    try { await bind(Number.isInteger(savedPort) && savedPort >= 1024 && savedPort <= 65535 ? savedPort : 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await bind(0);
    }
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Could not open the local server port.");
    await writeFile(portFile, String(address.port), { mode: 0o600 });
    server = await startServer({
      migrate: true, quiet: true, listener,
      env: {
        BENTO_MODE: "local", BENTO_HOST: "127.0.0.1", PORT: String(address.port), DATABASE_URL: databaseUrl,
        BETTER_AUTH_URL: `http://127.0.0.1:${address.port}`,
        BENTO_DATA_DIR: settings.dataDir, BENTO_SANDBOX_DRIVER: settings.sandbox,
        BENTO_SANDBOX_IMAGE: settings.sandboxImage,
        BENTO_WEB_DIR: path.join(import.meta.dirname, "web"),
      },
    });
    if (!stopping) send({ type: "ready", url: server.url });
  }
}

async function stop(): Promise<void> {
  stopping = true;
  await starting?.catch(() => {});
  await server?.stop();
  if (listener?.listening) {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener!.close(() => resolve()));
  }
  send({ type: "stopped" });
  process.exit(0);
}

parent.on("message", ({ data }: { data: RuntimeCommand }) => {
  if (data.type === "stop") { void stop(); return; }
  if (starting || stopping) return;
  starting = start(data).catch((error: unknown) => {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });
});
