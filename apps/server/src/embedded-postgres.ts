import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { waitForPostgres } from "./local-postgres.js";

const execFileAsync = promisify(execFile);

export interface EmbeddedPostgres {
  databaseUrl: string;
  port: number;
  /** The postmaster's pid, for a caller that has to kill it synchronously on its way out. */
  pid: number;
  /** True on the start that ran initdb into an empty data folder. */
  initialised: boolean;
  /** Fast shutdown, escalating to immediate and then SIGKILL. Idempotent. */
  stop(): Promise<void>;
}

export interface EmbeddedPostgresOptions {
  /**
   * A folder holding Postgres's `bin`, `lib` and `share`. Defaults to
   * BENTO_POSTGRES_DIR, then the `@embedded-postgres/<platform>-<arch>`
   * package installed beside this one.
   */
  installDir?: string;
  /** Postgres's own log lines. Defaults to dropping them. */
  onLog?: (line: string) => void;
  /** How long `stop()` waits for a fast shutdown before escalating. */
  stopTimeoutMs?: number;
}

const DATABASE = "app";
const USER = "postgres";

/**
 * Runs the Postgres binaries shipped as an npm package (or a folder the
 * Mac app bundles) against `<dataDir>/postgres`, on a free loopback
 * port, with no Docker and nothing installed. The second path beside
 * `ensureLocalPostgres`.
 *
 * Postgres is spawned in its own process group, so a Ctrl-C in a
 * terminal reaches only the caller, which can then stop the server
 * before the database it is still writing to.
 */
export async function ensureEmbeddedPostgres(
  dataDir: string,
  options: EmbeddedPostgresOptions = {},
): Promise<EmbeddedPostgres> {
  const log = options.onLog ?? (() => {});
  const bin = path.join(await resolveInstallDir(options.installDir), "bin");
  const pgdata = path.join(dataDir, "postgres");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  const password = await ensurePassword(path.join(dataDir, "postgres-password"));
  const initialised = await initialiseIfMissing(bin, dataDir, pgdata, password, log);
  await clearStaleServer(pgdata, log);

  let child: ChildProcess | undefined;
  let port = 0;
  // The port is free when probed and taken by the time Postgres binds
  // only if something else races for it, so one retry covers it.
  for (let attempt = 0; attempt < 3 && !child; attempt++) {
    port = await freePort();
    try {
      child = await startPostgres(bin, pgdata, port, log);
    } catch (err) {
      if (attempt === 2 || !/could not bind|Address already in use/i.test(String(err))) throw err;
    }
  }
  const proc = child!;

  const adminUrl = urlFor(password, port, "postgres");
  const stop = once(() => stopPostgres(proc, options.stopTimeoutMs ?? 8_000));
  try {
    await waitForPostgres(adminUrl, 60_000);
    await ensureDatabase(adminUrl);
  } catch (err) {
    await stop();
    throw err;
  }
  return { databaseUrl: urlFor(password, port, DATABASE), port, pid: proc.pid!, initialised, stop };
}

function urlFor(password: string, port: number, database: string): string {
  return `postgres://${USER}:${password}@127.0.0.1:${port}/${database}`;
}

async function resolveInstallDir(explicit: string | undefined): Promise<string> {
  const configured = explicit ?? process.env.BENTO_POSTGRES_DIR;
  if (configured) return configured;
  const name = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    const mod = (await import(name)) as { postgres: string };
    return path.resolve(path.dirname(mod.postgres), "..");
  } catch {
    throw new Error(
      `No Postgres binaries for ${process.platform}-${process.arch}: ${name} is not installed and BENTO_POSTGRES_DIR is not set.`,
    );
  }
}

/**
 * A random password rather than the Docker path's fixed one: the port
 * is loopback only, but every account on the Mac can reach loopback.
 */
async function ensurePassword(file: string): Promise<string> {
  const existing = await fs.readFile(file, "utf8").catch(() => "");
  if (existing.trim()) return existing.trim();
  const password = randomBytes(24).toString("hex");
  await fs.writeFile(file, password, { mode: 0o600 });
  return password;
}

/**
 * initdb runs into a sibling folder that is renamed into place, so a
 * crash halfway through leaves no half made cluster for the next start
 * to trip over.
 */
async function initialiseIfMissing(
  bin: string,
  dataDir: string,
  pgdata: string,
  password: string,
  log: (line: string) => void,
): Promise<boolean> {
  if (await exists(path.join(pgdata, "PG_VERSION"))) return false;
  if (await exists(pgdata)) {
    throw new Error(`${pgdata} exists but holds no Postgres cluster. Move it aside and start again.`);
  }
  for (const entry of await fs.readdir(dataDir)) {
    if (entry.startsWith("postgres.init-")) await fs.rm(path.join(dataDir, entry), { recursive: true, force: true });
  }
  const staging = path.join(dataDir, `postgres.init-${randomBytes(4).toString("hex")}`);
  const pwfile = path.join(dataDir, `postgres.pwfile-${randomBytes(4).toString("hex")}`);
  await fs.writeFile(pwfile, `${password}\n`, { mode: 0o600 });
  try {
    await run(path.join(bin, "initdb"), [
      `--pgdata=${staging}`,
      `--username=${USER}`,
      `--pwfile=${pwfile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
      "--locale-provider=builtin",
      "--builtin-locale=C.UTF-8",
      "--no-instructions",
    ], log);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  } finally {
    await fs.rm(pwfile, { force: true });
  }
  await fs.rename(staging, pgdata);
  return true;
}

/**
 * A crash leaves `postmaster.pid` behind. Postgres ignores one whose pid
 * is dead, but refuses to start when that pid now belongs to some other
 * process of this user, and a Postgres orphaned by a crashed parent is
 * still running on this folder. Stop the orphan; drop a file whose pid
 * is anything else.
 */
async function clearStaleServer(pgdata: string, log: (line: string) => void): Promise<void> {
  const pidFile = path.join(pgdata, "postmaster.pid");
  const contents = await fs.readFile(pidFile, "utf8").catch(() => null);
  if (contents === null) return;
  const pid = Number(contents.split("\n")[0]);
  const lockedDir = contents.split("\n")[1]?.trim();
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    const executable = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="])
      .then((r) => path.basename(r.stdout.trim()))
      .catch(() => "");
    if (pid !== process.pid && executable === "postgres" && lockedDir && path.resolve(lockedDir) === path.resolve(pgdata)) {
      log(`stopping a Postgres left running by an earlier start (pid ${pid})`);
      await signalAndWait(pid, "SIGINT", 8_000) || await signalAndWait(pid, "SIGQUIT", 3_000) || await signalAndWait(pid, "SIGKILL", 2_000);
      if (isAlive(pid)) throw new Error(`An earlier Postgres (pid ${pid}) is still running on ${pgdata} and could not be stopped.`);
    }
  }
  await fs.rm(pidFile, { force: true });
}

async function startPostgres(bin: string, pgdata: string, port: number, log: (line: string) => void): Promise<ChildProcess> {
  const child = spawn(path.join(bin, "postgres"), [
    "-D", pgdata,
    "-p", String(port),
    "-c", "listen_addresses=127.0.0.1",
    // No Unix socket: nothing here uses one, and the default /tmp path is shared with any other Postgres.
    "-c", "unix_socket_directories=",
    "-c", "lc_messages=C",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, LC_ALL: "C" } });
  let output = "";
  const onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (output.length < 8_000) output += text;
    for (const line of text.split("\n")) if (line.trim()) log(line);
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const settle = (err?: Error) => {
      clearInterval(poll);
      child.off("exit", onExit);
      child.off("error", settle);
      if (err) reject(err);
      else resolve();
    };
    const onExit = (code: number | null, signal: string | null) =>
      settle(new Error(`Postgres exited during start (code ${code}, signal ${signal}): ${output.trim().slice(-2_000)}`));
    child.once("exit", onExit);
    child.once("error", settle);
    // Crash recovery after an unclean stop replays WAL before this line, which can take a while.
    const poll = setInterval(() => {
      if (/ready to accept connections/.test(output)) settle();
      else if (Date.now() - started > 120_000) {
        child.kill("SIGKILL");
        settle(new Error(`Postgres did not start within 120s: ${output.trim().slice(-2_000)}`));
      }
    }, 50);
  });
  return child;
}

async function stopPostgres(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const waitFor = (ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
    return Promise.race([exited.then(() => true), timeout]).finally(() => clearTimeout(timer));
  };
  // SIGINT is Postgres's fast shutdown, SIGQUIT its immediate one.
  child.kill("SIGINT");
  if (await waitFor(timeoutMs)) return;
  child.kill("SIGQUIT");
  if (await waitFor(2_000)) return;
  child.kill("SIGKILL");
  await waitFor(2_000);
}

async function ensureDatabase(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const found = await client.query("select 1 from pg_database where datname = $1", [DATABASE]);
    if (found.rowCount === 0) await client.query(`create database ${DATABASE}`);
  } finally {
    await client.end();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function run(file: string, args: string[], log: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      for (const line of text.split("\n")) if (line.trim()) log(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(file)} failed (code ${code}): ${output.trim().slice(-2_000)}`)),
    );
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function signalAndWait(pid: number, signal: NodeJS.Signals, ms: number): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return true;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= fn());
}
