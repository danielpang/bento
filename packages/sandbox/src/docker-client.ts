import Docker from "dockerode";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Socket locations used by the common Docker runtimes on macOS and
 * Linux, in probe order. dockerode only looks at /var/run/docker.sock,
 * so OrbStack, Colima, and Rancher Desktop users would otherwise get
 * ECONNREFUSED even though `docker ps` works for them.
 */
function candidateSockets(): string[] {
  const home = homedir();
  return [
    "/var/run/docker.sock",
    path.join(home, ".docker/run/docker.sock"),
    path.join(home, ".orbstack/run/docker.sock"),
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".rd/docker.sock"),
  ];
}

/** The socket this machine's Docker is listening on, if one is found. */
export function resolveDockerSocket(): string | null {
  return candidateSockets().find((socket) => existsSync(socket)) ?? null;
}

/**
 * Creates a Docker client, honouring DOCKER_HOST first and otherwise
 * probing the known runtime sockets.
 */
export function createDockerClient(): Docker {
  // DOCKER_HOST wins: dockerode parses it natively.
  if (process.env.DOCKER_HOST) return new Docker();
  const socketPath = resolveDockerSocket();
  return socketPath ? new Docker({ socketPath }) : new Docker();
}
