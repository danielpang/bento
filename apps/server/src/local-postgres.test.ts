import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { waitForPostgres } from "./local-postgres.js";

/**
 * An open port is not a ready database.
 *
 * Docker publishes a container's port the moment it starts, so a readiness
 * check that only opened a socket returned while Postgres was still running
 * initdb, and the first query died with "Connection terminated
 * unexpectedly". A fresh data directory takes seconds to initialise, so
 * this broke precisely the first run on a new machine.
 */
test("a port that accepts TCP but speaks no Postgres is not ready", async () => {
  // Accepts the connection and then stays silent, the way Docker's port
  // proxy behaves while the database behind it is still starting.
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => accepted.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  try {
    await assert.rejects(
      waitForPostgres(`postgres://postgres:postgres@127.0.0.1:${port}/app`, 1_500),
      /did not become ready/,
      "an open port must not be mistaken for a usable database",
    );
  } finally {
    // close() waits for open connections, and the socket the probe left
    // behind never ends on its own, so drop it first or the run hangs.
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a database that answers a query is ready", async () => {
  const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
  await waitForPostgres(url, 15_000);
});
