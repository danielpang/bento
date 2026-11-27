import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SandboxDriver = "local-process" | "docker";

export interface SidecarConfig {
  dataDir: string;
  sandbox: SandboxDriver;
  /** Use this database instead of starting the embedded one. */
  databaseUrl?: string;
  /** 0 asks the OS for a free port. A taken port also falls back to a free one. */
  port: number;
  postgresDir?: string;
  webDir?: string;
  sandboxImage?: string;
  /** Holds the sandbox Dockerfile, built when the docker driver finds no image. */
  sandboxDockerfileDir?: string;
  betaFeatures?: boolean;
  modelProxy?: boolean;
}

/**
 * Reads the sidecar's configuration from its environment. Everything
 * is optional; see the README for each variable. `bundleDir` is where
 * the running script lives, so a bundled build finds the Postgres
 * binaries, console and Dockerfile copied beside it.
 */
export function readConfig(env: NodeJS.ProcessEnv, bundleDir: string): SidecarConfig {
  const sandbox = env.BENTO_SANDBOX_DRIVER ?? "local-process";
  if (sandbox !== "local-process" && sandbox !== "docker") {
    throw new Error(`BENTO_SANDBOX_DRIVER must be "local-process" or "docker", not "${sandbox}".`);
  }
  const port = Number(env.BENTO_SIDECAR_PORT ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`BENTO_SIDECAR_PORT must be a port number, not "${env.BENTO_SIDECAR_PORT}".`);
  }
  const besideBundle = (name: string) => {
    const candidate = path.resolve(bundleDir, "..", name);
    return fs.existsSync(candidate) ? candidate : undefined;
  };
  const optional: Omit<{ [K in keyof SidecarConfig]: SidecarConfig[K] | undefined }, "dataDir" | "sandbox" | "port"> = {
    databaseUrl: env.BENTO_DATABASE_URL || undefined,
    postgresDir: env.BENTO_POSTGRES_DIR || besideBundle("postgres"),
    webDir: env.BENTO_WEB_DIR || besideBundle("web"),
    sandboxImage: env.BENTO_SANDBOX_IMAGE || undefined,
    sandboxDockerfileDir: env.BENTO_SANDBOX_DOCKERFILE_DIR || besideBundle("sandbox"),
    betaFeatures: flag(env, "BENTO_BETA_FEATURES"),
    modelProxy: flag(env, "BENTO_MODEL_PROXY"),
  };
  return {
    dataDir: path.resolve(expandHome(env.BENTO_DATA_DIR || path.join(os.homedir(), ".bento"))),
    sandbox,
    port,
    ...(Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)) as Partial<SidecarConfig>),
  };
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be "true" or "false", not "${value}".`);
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}
