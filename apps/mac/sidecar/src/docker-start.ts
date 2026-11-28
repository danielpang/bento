import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerClient } from "@bento/sandbox";

/** The apps that can start Docker for Bento, in the order they are preferred. */
export const DOCKER_APPS = [
  { name: "OrbStack", bundle: "OrbStack.app" },
  { name: "Docker Desktop", bundle: "Docker.app" },
] as const;

export const DOCKER_NOT_INSTALLED_MESSAGE =
  "Install OrbStack or Docker Desktop, then try again. Local agents use Docker sandboxes.";

/** How long a launched app gets to answer before the start gives up. */
export const DOCKER_START_TIMEOUT_MS = 90_000;
const POLL_MS = 1_500;
/** One check's limit: a socket that accepts and never answers is a Docker still starting. */
export const DOCKER_PING_TIMEOUT_MS = 5_000;

export interface DockerStartDeps {
  /** Resolves when Docker answers. A fresh client each time: the socket may not exist until the app is up. */
  ping(): Promise<void>;
  exists(file: string): Promise<boolean>;
  /** Launches an app bundle, the way Finder would. */
  launch(bundlePath: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How long one ping may take before it counts as no answer. */
  pingTimeoutMs: number;
  platform: NodeJS.Platform;
  applicationDirs: string[];
}

export const realDockerStartDeps = (): DockerStartDeps => ({
  ping: async () => { await createDockerClient().ping(); },
  exists: (file) => access(file).then(() => true, () => false),
  launch: (bundlePath) => new Promise((resolve, reject) => {
    execFile("open", ["-g", "-a", bundlePath], (error) => error ? reject(error) : resolve());
  }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  pingTimeoutMs: DOCKER_PING_TIMEOUT_MS,
  platform: process.platform,
  applicationDirs: ["/Applications", path.join(os.homedir(), "Applications")],
});

/**
 * Makes sure Docker answers before local Bento needs it, starting OrbStack
 * (preferred) or Docker Desktop on macOS when it is installed but not
 * running. Throws a sentence the launcher shows when that cannot happen.
 * `cancelled` stops the wait when the person cancels or the app quits.
 */
export async function ensureDockerRunning(
  deps: DockerStartDeps,
  progress: (message: string) => void,
  cancelled: () => boolean,
): Promise<void> {
  if (await answers(deps)) return;
  if (deps.platform !== "darwin") throw new Error(DOCKER_NOT_INSTALLED_MESSAGE);

  const app = await installedApp(deps);
  if (!app) throw new Error(DOCKER_NOT_INSTALLED_MESSAGE);

  progress(`Starting ${app.name}...`);
  await deps.launch(app.path);
  const deadline = deps.now() + DOCKER_START_TIMEOUT_MS;
  while (deps.now() < deadline) {
    if (cancelled()) return;
    await deps.sleep(POLL_MS);
    if (await answers(deps)) return;
  }
  throw new Error(`${app.name} did not start. Open it, then try again.`);
}

async function answers(deps: DockerStartDeps): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), deps.pingTimeoutMs); });
  try {
    return await Promise.race([deps.ping().then(() => true, () => false), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function installedApp(deps: DockerStartDeps): Promise<{ name: string; path: string } | null> {
  for (const app of DOCKER_APPS) {
    for (const dir of deps.applicationDirs) {
      const bundlePath = path.join(dir, app.bundle);
      if (await deps.exists(bundlePath)) return { name: app.name, path: bundlePath };
    }
  }
  return null;
}
