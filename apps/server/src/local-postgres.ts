import type Docker from "dockerode";
import { createDockerClient } from "@bento/sandbox";
import net from "node:net";
import pg from "pg";

const CONTAINER_NAME = "bento-postgres";
const VOLUME_NAME = "bento-pgdata";
const IMAGE = "postgres:17-alpine";
const PREFERRED_PORT = 5439;

export interface LocalPostgres {
  databaseUrl: string;
  port: number;
  /** True when this call started the container rather than reusing it. */
  started: boolean;
}

export class DockerUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Docker is not reachable (${cause}).\n` +
        "Embedded mode runs Postgres and agent sandboxes in containers, so Docker must be running.\n" +
        "Start Docker Desktop or OrbStack, or point bento at a server with --server <url>, " +
        "or supply your own database with --db <postgres url>.",
    );
    this.name = "DockerUnavailableError";
  }
}

/**
 * Ensures a Postgres container exists, is running, and accepts
 * connections, then returns its URL.
 *
 * Embedded mode already requires Docker for agent sandboxes, so using it
 * for the database too keeps `bento` a single command with no compose file
 * and no host Postgres install. Data lives in a named volume, so it
 * survives container replacement.
 *
 * The host port is chosen at creation time and read back from the
 * container afterwards, so an unrelated Postgres already holding the
 * preferred port does not break anything.
 */
export async function ensureLocalPostgres(): Promise<LocalPostgres> {
  const docker = createDockerClient();
  try {
    await docker.ping();
  } catch (err) {
    throw new DockerUnavailableError(String((err as Error).message ?? err));
  }

  const existing = await inspectManaged(docker);
  if (existing) {
    let started = false;
    if (!existing.running) {
      await docker.getContainer(CONTAINER_NAME).start();
      started = true;
    }
    await waitForPostgres(urlFor(existing.port), 60_000);
    return { databaseUrl: urlFor(existing.port), port: existing.port, started };
  }

  await pullIfMissing(docker);
  const port = await findFreePort(PREFERRED_PORT);
  const created = await docker.createContainer({
    name: CONTAINER_NAME,
    Image: IMAGE,
    Env: ["POSTGRES_USER=postgres", "POSTGRES_PASSWORD=postgres", "POSTGRES_DB=app"],
    Labels: { "dev.bento.managed": "true" },
    HostConfig: {
      // Loopback only: this database serves one machine's local runs.
      PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] },
      Binds: [`${VOLUME_NAME}:/var/lib/postgresql/data`],
      RestartPolicy: { Name: "unless-stopped" },
    },
  });
  try {
    await created.start();
  } catch (err) {
    // A container that failed to start would block every later attempt.
    await created.remove({ force: true }).catch(() => {});
    throw err;
  }

  await waitForPostgres(urlFor(port), 60_000);
  return { databaseUrl: urlFor(port), port, started: true };
}

function urlFor(port: number): string {
  return `postgres://postgres:postgres@127.0.0.1:${port}/app`;
}

interface ManagedInfo {
  running: boolean;
  port: number;
}

/** Reads the managed container's state and bound host port, if it exists. */
async function inspectManaged(docker: Docker): Promise<ManagedInfo | null> {
  try {
    const info = await docker.getContainer(CONTAINER_NAME).inspect();
    const binding = info.NetworkSettings?.Ports?.["5432/tcp"]?.[0]?.HostPort;
    const port = binding ? Number(binding) : PREFERRED_PORT;

    // A container that exists but never started successfully is useless
    // and blocks creation by name, so replace it.
    if (!info.State.Running && info.State.ExitCode !== 0 && info.State.StartedAt === "0001-01-01T00:00:00Z") {
      await docker.getContainer(CONTAINER_NAME).remove({ force: true });
      return null;
    }
    return { running: info.State.Running, port };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

async function pullIfMissing(docker: Docker): Promise<void> {
  const images = await docker.listImages({ filters: { reference: [IMAGE] } });
  if (images.length > 0) return;
  const stream = await docker.pull(IMAGE);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error(`no free port found between ${start} and ${start + 50}`);
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(700);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Waits for a connection that can actually run a query.
 *
 * An open port does not mean a ready database. Docker publishes the port
 * the moment the container starts, so a TCP probe connects while Postgres
 * is still running initdb, and the first real query dies with
 * "Connection terminated unexpectedly". A fresh data directory takes a
 * couple of seconds to initialise, which is precisely the first run on a
 * new machine.
 *
 * Exported for the test that holds this behaviour in place.
 */
export async function waitForPostgres(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no connection attempt completed";
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    // end() never settles on a client that failed to connect, so it is
    // called only once there is a connection to close. pg tears down the
    // socket itself when connecting times out.
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.query("select 1");
      return;
    } catch (err) {
      lastError = (err as Error).message;
    } finally {
      if (connected) await client.end().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Postgres did not become ready within ${Math.round(timeoutMs / 1000)}s: ${lastError}`);
}
