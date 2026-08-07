import { SpritesClient, type Sprite, type SpriteCommand } from "@fly/sprites";
import { AGENT_BINARIES, AGENT_TOOLCHAIN_SCRIPT, TOOLCHAIN_MARKER } from "./agent-toolchain.js";
import {
  collectExec,
  type ExecChunk,
  type ExecOptions,
  type ProvisionSpec,
  type RepositoryBundle,
  type SandboxDriver,
  type SandboxHandle,
} from "./driver.js";

export interface SpriteDriverOptions {
  token: string;
  /** Sprite size. Agents are IO heavy rather than CPU heavy. */
  ramMB?: number;
  cpus?: number;
  region?: string;
  /** Where repositories are checked out inside the sprite. */
  workdir?: string;
  /** Request timeout. Long by default, because provisioning installs. */
  timeoutMs?: number;
}

/**
 * Runs agents in Fly Sprites: persistent Linux machines that hibernate
 * when idle and wake on demand.
 *
 * One sprite per feature, not per run. The filesystem survives
 * hibernation, so a feature keeps its checkouts, installed dependencies,
 * and caches between stages, and the second stage starts warm.
 *
 * Unlike the Docker driver there is no host filesystem to bind mount, so
 * repositories are cloned inside the sprite. Callers pass clone URLs
 * through ProvisionSpec.repositories.
 */
export class SpriteDriver implements SandboxDriver {
  provider = "sprite" as const;
  private client: SpritesClient;
  private workdir: string;

  constructor(private options: SpriteDriverOptions) {
    // The default request timeout is thirty seconds, which is fine for
    // every call except the first: installing the agent CLIs into a
    // fresh sprite takes minutes, and a timeout there would leave a
    // half-installed machine behind and fail the run.
    this.client = new SpritesClient(options.token, { timeout: options.timeoutMs ?? 15 * 60_000 });
    this.workdir = options.workdir ?? "/workspace";
  }

  private spriteName(featureId: string): string {
    // Sprite names are DNS-ish; a uuid with dashes is fine.
    return `bento-${featureId}`;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const name = this.spriteName(spec.featureId);
    const say = async (message: string) => {
      await spec.onProgress?.(message);
    };

    let sprite: Sprite;
    let reused = true;
    try {
      sprite = await this.client.getSprite(name);
    } catch {
      reused = false;
      sprite = await this.client.createSprite(name, {
        ramMB: this.options.ramMB ?? 4096,
        cpus: this.options.cpus ?? 2,
        ...(this.options.region ? { region: this.options.region } : {}),
      } as Parameters<SpritesClient["createSprite"]>[1]);
    }
    await say(reused ? `Reusing this card's cloud sandbox (${name}).` : `Created cloud sandbox ${name}.`);

    // One round trip prepares the workspace and answers whether the
    // agent CLIs are already there, so the wait that follows can be
    // named before it happens rather than discovered after.
    const probe = await runScript(
      sprite,
      [
        "set -eu",
        `mkdir -p ${shellQuote(this.workdir)}`,
        `if [ -f ${shellQuote(TOOLCHAIN_MARKER)} ]; then echo tools-present; else echo tools-absent; fi`,
      ].join("\n"),
    );
    const toolsPresent = probe.stdout.includes("tools-present");

    /**
     * A sprite is a bare machine, not an image: there is nowhere to bake
     * the agent CLIs the way the Docker driver does, so they are
     * installed on first provision. The script exits at once when the
     * marker is already there, which is every stage after a card's
     * first.
     */
    if (toolsPresent) {
      await say("Agent tools are already installed.");
      await runScript(sprite, AGENT_TOOLCHAIN_SCRIPT);
    } else {
      await say("Installing the agent tools. This takes a few minutes on a new sandbox.");
      const started = Date.now();
      await runScript(sprite, AGENT_TOOLCHAIN_SCRIPT);
      await say(`Agent tools installed in ${Math.round((Date.now() - started) / 1000)}s.`);
    }

    // Repositories live inside the sprite, so clone what is missing and
    // fetch what is already there.
    for (const repo of spec.repositories ?? []) {
      if (!repo.cloneUrl) continue;
      const dir = `${this.workdir}/${repo.name}`;
      const branch = repo.branch ?? "main";
      const baseBranch = repo.baseBranch ?? "main";
      await say(`Preparing repository ${repo.name}...`);
      const verifyIdentity = [
        `if [ -d ${shellQuote(dir)}/.git ]; then`,
        `  current_origin=$(git -C ${shellQuote(dir)} remote get-url origin 2>/dev/null || true)`,
        `  if [ "$current_origin" != ${shellQuote(repo.cloneUrl)} ]; then rm -rf ${shellQuote(dir)}; fi`,
        "fi",
      ];
      if (repo.seedBundle) {
        const bundlePath = `/tmp/bento-seed-${repo.name}.bundle`;
        await sprite.filesystem("/").writeFile(bundlePath, repo.seedBundle);
        try {
          const script = [
            "set -eu",
            ...verifyIdentity,
            `if [ -d ${shellQuote(dir)}/.git ]; then`,
            `  cd ${shellQuote(dir)} && git fetch ${shellQuote(bundlePath)} refs/heads/${shellQuotePart(baseBranch)}:refs/remotes/origin/${shellQuotePart(baseBranch)}`,
            "else",
            `  git clone ${shellQuote(bundlePath)} ${shellQuote(dir)}`,
            `  cd ${shellQuote(dir)} && git remote set-url origin ${shellQuote(repo.cloneUrl)}`,
            "fi",
            `cd ${shellQuote(dir)} && (git checkout ${shellQuote(branch)} || git checkout -b ${shellQuote(branch)} ${shellQuote(`origin/${baseBranch}`)})`,
          ].join("\n");
          await runScript(sprite, script);
        } finally {
          await sprite.filesystem("/").rm(bundlePath).catch(() => {});
        }
      } else {
        const script = [
          "set -eu",
          ...verifyIdentity,
          `if [ -d ${shellQuote(dir)}/.git ]; then`,
          `  cd ${shellQuote(dir)} && git fetch --all --prune`,
          `else`,
          `  git clone ${shellQuote(repo.cloneUrl)} ${shellQuote(dir)}`,
          `fi`,
          `cd ${shellQuote(dir)} && (git checkout ${shellQuote(branch)} || git checkout -b ${shellQuote(branch)})`,
        ].join("\n");
        await runScript(sprite, script);
      }
      await say(`Repository ${repo.name} is ready on branch ${branch}.`);
    }

    // A Sprite persists for the life of a feature. Removing a repository
    // from the project must remove its old checkout too, otherwise every
    // later agent can still read and modify it.
    const keep = new Set((spec.repositories ?? []).map((repo) => repo.name));
    const filesystem = sprite.filesystem("/");
    const entries = await filesystem.readdir(this.workdir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      const candidate = `${this.workdir}/${entry.name}`;
      if (!(await filesystem.exists(`${candidate}/.git`))) continue;
      await filesystem.rm(candidate, { recursive: true, force: true });
    }

    return { externalId: name, provider: "sprite", workdir: this.workdir };
  }

  /**
   * Every sprite installs the whole set on its first provision, so the
   * answer is known without asking: there is no machine to inspect
   * until a card has one, and by then the tools are there.
   */
  async checkTools(binaries: readonly string[]): Promise<Record<string, boolean> | null> {
    const installed = new Set<string>(AGENT_BINARIES);
    return Object.fromEntries(binaries.map((binary) => [binary, installed.has(binary)]));
  }

  async *exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const sprite = await this.client.getSprite(handle.externalId);
    const [command, ...args] = argv;
    if (!command) throw new Error("empty argv");

    const child = sprite.spawn(command, args, {
      cwd: opts?.cwd ?? handle.workdir,
      ...(opts?.env ? { env: opts.env } : {}),
    });
    const stopKeepaliveGuard = defuseKeepalive(child);
    closeStdin(child);

    const queue: ExecChunk[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const push = (chunk: ExecChunk) => {
      queue.push(chunk);
      notify?.();
    };

    child.stdout.on("data", (d: Buffer | string) => push({ kind: "stdout", data: d.toString() }));
    child.stderr.on("data", (d: Buffer | string) => push({ kind: "stderr", data: d.toString() }));
    child.on("error", (err: Error) => {
      push({ kind: "stderr", data: String(err) });
      push({ kind: "exit", exitCode: -1 });
      done = true;
      notify?.();
    });
    child.on("exit", (code: number | null) => {
      push({ kind: "exit", exitCode: code ?? -1 });
      done = true;
      notify?.();
    });

    /**
     * A kill travels over the same WebSocket as the output, so a kill
     * sent on a dead connection is sent into the void and no exit event
     * ever comes back. Without a bound, the stream then waits forever
     * and the run holds its worker slot until the server restarts. The
     * reaper turns that into a failed run.
     */
    let reap: NodeJS.Timeout | null = null;
    const kill = () => {
      void child.kill();
      if (!reap) {
        reap = setTimeout(() => {
          if (done) return;
          push({ kind: "stderr", data: "the sandbox did not confirm the process ended after it was told to stop" });
          push({ kind: "exit", exitCode: -1 });
          done = true;
        }, 15_000);
        reap.unref?.();
      }
    };
    const onAbort = () => kill();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = opts?.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;

    try {
      while (true) {
        while (queue.length > 0) {
          const chunk = queue.shift()!;
          yield chunk;
          if (chunk.kind === "exit") return;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      stopKeepaliveGuard();
      if (timeout) clearTimeout(timeout);
      if (reap) clearTimeout(reap);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Point-in-time snapshot, taken before a run so a bad change can be
   * rolled back without losing the warm filesystem.
   *
   * createCheckpoint returns a progress stream rather than the
   * checkpoint, so the stream is drained first and the newest checkpoint
   * read back afterwards.
   */
  async snapshot(handle: SandboxHandle, label: string): Promise<string> {
    const sprite = await this.client.getSprite(handle.externalId);
    const stream = await sprite.createCheckpoint(label);
    await stream.processAll(() => {});

    const checkpoints = await sprite.listCheckpoints();
    let newest: { id: string; createTime: Date } | undefined;
    for (const checkpoint of checkpoints) {
      if (!newest || checkpoint.createTime > newest.createTime) newest = checkpoint;
    }
    if (!newest) throw new Error("checkpoint was created but none is listed");
    return newest.id;
  }

  /** Restores the sandbox filesystem to a checkpoint. */
  async restore(handle: SandboxHandle, snapshotId: string): Promise<void> {
    const sprite = await this.client.getSprite(handle.externalId);
    const stream = await sprite.restoreCheckpoint(snapshotId);
    await stream.processAll(() => {});
  }

  async exportRepository(
    handle: SandboxHandle,
    repositoryName: string,
    baseBranch: string,
  ): Promise<RepositoryBundle | null> {
    const dir = `${handle.workdir}/${repositoryName}`;
    const script = [
      "set -eu",
      `cd ${shellQuote(dir)}`,
      `base=${shellQuote(baseBranch)}`,
      'if ! git rev-parse --verify "$base^{commit}" >/dev/null 2>&1; then base="origin/$base"; fi',
      'base_sha=$(git rev-parse "$base^{commit}")',
      'head_sha=$(git rev-parse "HEAD^{commit}")',
      'if [ "$base_sha" = "$head_sha" ]; then exit 3; fi',
      'tmp=$(mktemp /tmp/bento-bundle.XXXXXX)',
      'trap \'rm -f "$tmp"\' EXIT',
      'git bundle create "$tmp" HEAD "^$base_sha" >/dev/null',
      'printf "%s\\n%s\\n" "$base_sha" "$head_sha"',
      'base64 "$tmp"',
    ].join("\n");
    const result = await collectExec(this.exec(handle, ["sh", "-lc", script], { timeoutMs: 60_000 }));
    if (result.exitCode === 3) return null;
    if (result.exitCode !== 0) {
      throw new Error(`could not export ${repositoryName}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    const [baseSha, headSha, ...encoded] = result.stdout.trim().split("\n");
    if (!baseSha || !headSha || encoded.length === 0) {
      throw new Error(`could not export ${repositoryName}: malformed bundle response`);
    }
    return { baseSha, headSha, data: Buffer.from(encoded.join(""), "base64") };
  }

  /** Sprites hibernate on their own; this is here for symmetry. */
  async hibernate(): Promise<void> {
    // Nothing to do: the platform suspends idle sprites automatically.
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.client.deleteSprite(handle.externalId).catch(() => {});
  }
}

/**
 * Runs a script through a shell inside the sprite.
 *
 * `sprite.exec(string)` reads like a shell and is not one: the SDK
 * splits the string on whitespace and execs the first word with the
 * rest as arguments. A provisioning script handed to it arrives as a
 * command named `set` carrying a hundred arguments, and every quote,
 * `&&`, `$VAR`, and `if` in it means nothing. Provisioning failed on
 * its first real attempt with `ExecError: exit code 1` because of it.
 *
 * The scripts here are sh, so they go to sh. `-c` rather than `-lc`:
 * the installers put binaries in /usr/local/bin precisely so nothing
 * has to depend on a login shell's profile.
 *
 * spawn rather than execFile: execFile hides its connection inside a
 * promise, and these scripts need defuseKeepalive on that connection.
 * An installer that downloads quietly for 45 seconds would otherwise
 * be cut off the same way agent runs were.
 */
function runScript(
  sprite: Sprite,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = sprite.spawn("sh", ["-c", script]);
  const stopKeepaliveGuard = defuseKeepalive(child);
  closeStdin(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => {
      stopKeepaliveGuard();
      reject(err);
    });
    child.on("exit", (code: number | null) => {
      stopKeepaliveGuard();
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        // stdout and stderr ride on the error, the shape run-executor's
        // describeSandboxError reads to put installer output in the run
        // record.
        reject(
          Object.assign(new Error(`provisioning script failed with exit code ${exitCode}`), { stdout, stderr }),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Sends end-of-input to the spawned process as soon as its connection
 * is up.
 *
 * The SDK asks the server to open the command's stdin on every exec
 * (stdin=true on the URL) and only sends the end-of-input frame when
 * this side ends the stdin stream. Nothing here writes to stdin, so
 * without this the process sits behind a pipe that never closes. An
 * agent CLI treats a piped stdin as input it must read before
 * starting (opencode's run awaits stdin to EOF), so a run produced
 * not a single event, indefinitely. The SDK's keepalive used to cut
 * exactly those runs off after 45 quiet seconds, which read as a
 * websocket failure; once defuseKeepalive turned that off, the same
 * hang simply ran until the 30 minute limit.
 *
 * On "spawn" rather than immediately, because the SDK drops the EOF
 * frame silently while the socket is still connecting, and "spawn"
 * fires once it is open.
 */
function closeStdin(child: SpriteCommand): void {
  child.on("spawn", () => child.stdin.end());
}

/**
 * Stops the SDK's own keepalive from killing a quiet command.
 *
 * @fly/sprites never sends a ping: its WSCommand only stamps an
 * activity clock when output arrives, and after 45 seconds without
 * any it declares the connection dead ("WebSocket keepalive timeout")
 * and closes it. A coding agent inside a long tool call or a long
 * model turn is exactly that quiet, so every run died the first time
 * its CLI spent 45 seconds working in silence. The process itself was
 * fine; only the client gave up.
 *
 * Resetting the clock from outside turns the fabricated timeout off
 * while leaving real failure signals alone: a connection that
 * actually breaks still surfaces through the socket's error and close
 * events. The clock lives on a private property of a private object,
 * reached by duck type; the pin test in sprite.test.ts fails against
 * the installed SDK if either name changes.
 */
function defuseKeepalive(child: unknown): () => void {
  const timer = setInterval(() => {
    const ws = (child as { wsCmd?: { resetKeepalive?: () => void } }).wsCmd;
    ws?.resetKeepalive?.();
  }, 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Minimal POSIX single-quote escaping for interpolated paths and URLs. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuotePart(value: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("unsafe git reference");
  return value;
}
