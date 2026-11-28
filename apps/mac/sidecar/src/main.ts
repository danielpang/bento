import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddedPostgres, RunningServer } from "@bento/server";
import { readConfig, type SidecarConfig } from "./config.js";
import { claimStdout } from "./protocol.js";

const emit = claimStdout();
const SHUTDOWN_LIMIT_MS = 12_000;

let server: RunningServer | undefined;
let listener: Server | undefined;
let postgres: EmbeddedPostgres | undefined;
let starting: Promise<void> | undefined;
let stopping = false;

async function start(config: SidecarConfig): Promise<void> {
  const { ensureEmbeddedPostgres, startServer } = await import("@bento/server");
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });

  if (config.sandbox === "docker") await prepareDocker(config);
  if (stopping) return;

  let databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    emit({ event: "progress", message: "Starting the local database." });
    postgres = await ensureEmbeddedPostgres(config.dataDir, {
      ...(config.postgresDir ? { installDir: config.postgresDir } : {}),
      onLog: (line) => process.stderr.write(`[postgres] ${line}\n`),
      stopTimeoutMs: 6_000,
    });
    databaseUrl = postgres.databaseUrl;
    if (stopping) return;
  }

  emit({ event: "progress", message: "Setting up the database and starting Bento." });
  listener = await reserve(config.port);
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not open the local server port.");
  const env: Record<string, string> = {
    BENTO_MODE: "local",
    BENTO_HOST: "127.0.0.1",
    PORT: String(address.port),
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: `http://127.0.0.1:${address.port}`,
    BENTO_DATA_DIR: config.dataDir,
    BENTO_SANDBOX_DRIVER: config.sandbox,
  };
  if (config.sandboxImage) env.BENTO_SANDBOX_IMAGE = config.sandboxImage;
  if (config.webDir) env.BENTO_WEB_DIR = config.webDir;
  if (config.betaFeatures !== undefined) env.BENTO_BETA_FEATURES = String(config.betaFeatures);
  if (config.modelProxy !== undefined) env.BENTO_MODEL_PROXY = String(config.modelProxy);
  server = await startServer({ migrate: true, quiet: true, listener, env });
  if (stopping) return;
  emit({
    event: "ready",
    url: server.url,
    port: server.port,
    databasePort: postgres?.port ?? null,
    sandbox: server.sandboxDriver,
  });
}

/** Starts Docker if it is installed and not running, and builds the sandbox image when it is missing. */
async function prepareDocker(config: SidecarConfig): Promise<void> {
  const { createDockerClient } = await import("@bento/sandbox");
  const { ensureDockerRunning, realDockerStartDeps } = await import("./docker-start.js");
  const { parseBuildStep, sandboxProgressMessage } = await import("./sandbox-progress.js");
  await ensureDockerRunning(realDockerStartDeps(), (message) => emit({ event: "progress", message }), () => stopping);
  if (stopping) return;
  const image = config.sandboxImage ?? "bento-sandbox:dev";
  const docker = createDockerClient();
  const images = await docker.listImages({ filters: { reference: [image] } });
  if (images.length) return;
  if (!config.sandboxDockerfileDir) {
    throw new Error(`The sandbox image ${image} is missing and BENTO_SANDBOX_DOCKERFILE_DIR is not set to build it.`);
  }
  const began = Date.now();
  let current: ReturnType<typeof parseBuildStep> = null;
  const report = () => emit({ event: "progress", message: sandboxProgressMessage(current, Date.now() - began) });
  report();
  const ticker = setInterval(report, 5_000);
  try {
    const stream = await docker.buildImage({ context: config.sandboxDockerfileDir, src: ["Dockerfile"] }, { t: image });
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (error) => (error ? reject(error) : resolve()),
        (event: { stream?: string }) => {
          const step = parseBuildStep(event);
          if (step) {
            current = step;
            report();
          }
        },
      );
    });
  } finally {
    clearInterval(ticker);
  }
}

/** Binds the requested loopback port, or any free one when it is 0 or taken. */
async function reserve(port: number): Promise<Server> {
  const http = createServer();
  const bind = (p: number) =>
    new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(p, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
  try {
    await bind(port);
  } catch (error) {
    if (port === 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await bind(0);
  }
  return http;
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  emit({ event: "stopping", reason });
  const force = setTimeout(() => {
    process.stderr.write(`shutdown took longer than ${SHUTDOWN_LIMIT_MS / 1000}s, forcing exit\n`);
    if (postgres) {
      try {
        process.kill(postgres.pid, "SIGKILL");
      } catch {}
    }
    emit({ event: "stopped", code: 1 });
    process.exit(1);
  }, SHUTDOWN_LIMIT_MS);
  await starting?.catch(() => {});
  await server?.stop().catch((err: unknown) => process.stderr.write(`server stop failed: ${String(err)}\n`));
  if (listener?.listening) {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener!.close(() => resolve()));
  }
  await postgres?.stop().catch((err: unknown) => process.stderr.write(`postgres stop failed: ${String(err)}\n`));
  clearTimeout(force);
  emit({ event: "stopped", code });
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));
// The parent holds our stdin open; when it closes, the parent is gone.
process.stdin.on("end", () => void shutdown("stdin closed", 0));
process.stdin.on("close", () => void shutdown("stdin closed", 0));
process.stdin.on("error", () => void shutdown("stdin closed", 0));
process.stdin.resume();
// Backstop for a parent that died without closing our stdin (a FIFO on macOS never reports EOF).
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) void shutdown("parent exited", 0);
}, 1_000).unref();
process.on("uncaughtException", (error) => {
  emit({ event: "error", message: error.message });
  process.stderr.write(`${error.stack ?? error.message}\n`);
  void shutdown("uncaught exception", 1);
});

try {
  const config = readConfig(process.env, path.dirname(fileURLToPath(import.meta.url)));
  starting = start(config);
  await starting;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ event: "error", message });
  process.stderr.write(`${error instanceof Error ? (error.stack ?? message) : message}\n`);
  starting = undefined;
  await shutdown("start failed", 1);
}
