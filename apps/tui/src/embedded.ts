import { ensureLocalPostgres, startServer, type RunningServer } from "@bento/server";
import type { CliOptions } from "./cli-options.js";

export interface EmbeddedHandle {
  url: string;
  sandbox: string;
  stop(): Promise<void>;
}

/**
 * Runs the whole stack inside the TUI process: database, queue,
 * orchestrator, sandboxes, and API. Same code path a self-hosted
 * deployment uses, just bound to a loopback port nobody else needs to
 * know about.
 */
export async function startEmbedded(
  options: CliOptions,
  onProgress: (message: string) => void,
): Promise<EmbeddedHandle> {
  let databaseUrl = options.db;
  if (!databaseUrl) {
    onProgress("Starting the local database...");
    const postgres = await ensureLocalPostgres();
    databaseUrl = postgres.databaseUrl;
    onProgress(postgres.started ? "Database started." : "Database already running.");
  }

  onProgress("Applying migrations...");
  let server: RunningServer;
  try {
    server = await startServer({
      migrate: true,
      quiet: true,
      env: {
        BENTO_MODE: "local",
        DATABASE_URL: databaseUrl,
        BENTO_SANDBOX_DRIVER: options.sandbox,
        BENTO_DATA_DIR: options.dataDir,
        BENTO_SHARE_AGENT_AUTH: String(options.shareAgentAuth),
        PORT: String(options.port),
      },
    });
  } catch (err) {
    throw new Error(`could not start the local server: ${(err as Error).message}`);
  }

  onProgress("Ready.");
  return {
    url: server.url,
    sandbox: server.sandboxDriver,
    stop: () => server.stop(),
  };
}
