import { SpritesClient, type Sprite, type SpriteCommand } from "@fly/sprites";
import {
  AGENT_BINARIES,
  AGENT_TOOLCHAIN_SCRIPT,
  TOOLCHAIN_MARKER,
  toolchainMissing,
} from "./agent-toolchain.js";
import {
  collectExec,
  type ExecChunk,
  type ExecOptions,
  type ProvisionSpec,
  type RepositoryBundle,
  type SandboxDriver,
  type SandboxHandle,
} from "./driver.js";

/**
 * The machine a feature's work happens on. Exported because a test that
 * provisions a real sprite has to be able to delete it by name even
 * when provisioning threw halfway, and guessing the convention in two
 * places is how a leaked machine goes on being billed.
 *
 * Sprite names are DNS-ish; a uuid with dashes is fine.
 */
export function spriteName(featureId: string): string {
  return `bento-${featureId}`;
}

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
  /** The SDK carries stdin over the exec socket; see feedStdin. */
  supportsStdin = true;
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
    return spriteName(featureId);
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
     * marker is there and every CLI resolves, which is every stage
     * after a card's first; a CLI that is missing because its installer
     * had a bad minute is retried here, and only that one.
     */
    let toolchain: { stdout: string };
    if (toolsPresent) {
      await say("Agent tools are already installed.");
      toolchain = await runScript(sprite, AGENT_TOOLCHAIN_SCRIPT);
    } else {
      await say("Installing the agent tools. This takes a few minutes on a new sandbox.");
      const started = Date.now();
      toolchain = await runScript(sprite, AGENT_TOOLCHAIN_SCRIPT);
      await say(`Agent tools installed in ${Math.round((Date.now() - started) / 1000)}s.`);
    }

    /**
     * A CLI whose installer was unreachable is said here, in the run's
     * own transcript, rather than left for the agent to fail on with a
     * shell's "not found". The script only reports what is genuinely
     * absent from the PATH afterwards, and the next provision retries
     * it, so this is a delay to name rather than a sandbox to throw
     * away: the other agents still run.
     */
    const missing = toolchainMissing(toolchain.stdout);
    if (missing.length > 0) {
      await say(
        `Could not install ${missing.join(", ")} in this sandbox. Cards that use those agents will fail to start until an install succeeds, which the next run tries again.`,
      );
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
        // Filesystem calls carry no SDK timeout at all; see bounded.
        await bounded(
          sprite.filesystem("/").writeFile(bundlePath, repo.seedBundle),
          FILESYSTEM_TIMEOUT_MS,
          `writing the ${repo.name} seed bundle`,
        );
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
          await bounded(sprite.filesystem("/").rm(bundlePath), FILESYSTEM_TIMEOUT_MS, "removing the seed bundle").catch(
            () => {},
          );
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
    const entries = await bounded(
      filesystem.readdir(this.workdir, { withFileTypes: true }),
      FILESYSTEM_TIMEOUT_MS,
      "listing the workspace",
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      const candidate = `${this.workdir}/${entry.name}`;
      if (!(await bounded(filesystem.exists(`${candidate}/.git`), FILESYSTEM_TIMEOUT_MS, "checking a checkout"))) {
        continue;
      }
      await bounded(
        filesystem.rm(candidate, { recursive: true, force: true }),
        FILESYSTEM_TIMEOUT_MS,
        `removing the old ${entry.name} checkout`,
      );
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

  /**
   * One WebSocket used to carry an entire agent run, and any blip on it
   * used to end the run: the SDK surfaces a dropped socket as an exit
   * with no code, which read as the agent dying ("stopped before
   * reporting a result, exit code -1") half an hour into a task the
   * process inside the sprite was still working on. The socket is not
   * the process. Every exec now asks the server to keep the command
   * running for a grace period after a disconnect, and a socket that
   * closes without a real exit is answered by reattaching to the still
   * running session rather than by failing the run.
   */
  async *exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const sprite = await this.client.getSprite(handle.externalId);
    const [command, ...args] = argv;
    if (!command) throw new Error("empty argv");

    const queue: ExecChunk[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const push = (chunk: ExecChunk) => {
      queue.push(chunk);
      notify?.();
    };

    /**
     * Which connection carries the run right now. `latest` is the last
     * connection made, open or not, and is where kills go; `active` is
     * only set while its socket is open, so stdin lines are never
     * written into a closed connection.
     */
    let latest: SpriteCommand | null = null;
    let active: SpriteCommand | null = null;
    let stopKeepaliveGuard: () => void = () => {};
    let killed = false;

    /**
     * The live conversation outlives any single connection: the pump
     * below writes each line to whichever connection is open, waiting
     * out the gap a reattach leaves. `stdinDone` records that the
     * conversation is over, so every later connection passes the
     * end-of-input frame on to the process. The SDK holds the process's
     * stdin open until this side ends it, and an agent CLI reads a
     * piped stdin to EOF before starting, so a run whose stdin never
     * closed produced not a single event, indefinitely. Writes wait for
     * "spawn" because lines and the EOF frame are dropped or refused
     * while a socket is still connecting.
     */
    let stdinDone = !opts?.stdin;
    const stdinWaiters: (() => void)[] = [];
    const wakeStdin = () => {
      for (const wake of stdinWaiters.splice(0)) wake();
    };
    const waitForOpen = (): Promise<SpriteCommand | null> => {
      if (active) return Promise.resolve(active);
      if (done) return Promise.resolve(null);
      return new Promise((resolve) => {
        stdinWaiters.push(() => resolve(active));
      });
    };
    const pump = async (lines: AsyncIterable<string>) => {
      try {
        for await (const line of lines) {
          const target = active ?? (await waitForOpen());
          if (!target) return; // the run ended before the line could go
          target.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
        }
      } catch {
        // The conversation source failed; the exit chunk tells the story.
      } finally {
        stdinDone = true;
        active?.stdin.end();
      }
    };
    if (opts?.stdin) void pump(opts.stdin);

    /** Exactly one exit chunk ends the stream, whichever path is first. */
    const conclude = (exitCode: number, reason?: string) => {
      if (done) return;
      if (reason) push({ kind: "stderr", data: reason });
      push({ kind: "exit", exitCode });
      done = true;
      wakeStdin();
    };

    /**
     * The socket went away without a process exit. When the stopping
     * was ours the process is meant to die with the socket, so the run
     * ends here; otherwise the process is presumed alive inside the
     * grace window and the run follows it through a reattach.
     */
    const lost = (code: number | null) => {
      if (done) return;
      if (killed) {
        conclude(code ?? -1, "the connection to the sandbox closed before the command reported an exit");
        return;
      }
      push({ kind: "stderr", data: "the connection to the sandbox dropped, reattaching to the running command" });
      void reattach();
    };

    /**
     * Finds the surviving session and picks the stream back up.
     *
     * Sessions are matched by their command's first word rather than by
     * substring: the full command line carries the whole prompt, which
     * contains almost any text one could match on. One feature has one
     * sprite and one running agent (startRunIfIdle enforces it), so the
     * newest match is the run's own session.
     *
     * A listSessions answer without the session is conclusive, the
     * process ended while the socket was down, and its exit code and
     * final output are gone with it; retrying would not bring it back.
     * Only transport failures retry, because the same outage that took
     * the socket usually takes the next few API calls too.
     */
    const reattach = async () => {
      for (let attempt = 0; ; attempt++) {
        if (done || killed) return;
        try {
          const fresh = await this.client.getSprite(handle.externalId);
          const sessions = await fresh.listSessions();
          if (done || killed) return;
          const mine = sessions
            .filter((s) => !s.tty && (s.command === command || s.command.startsWith(`${command} `)))
            .sort((a, b) => b.created.getTime() - a.created.getTime())[0];
          if (!mine) {
            conclude(
              -1,
              "the connection to the sandbox closed before the command reported an exit, and the process was gone when the driver tried to reattach",
            );
            return;
          }
          const attach = fresh.spawn(command, [], { sessionId: mine.id });
          const guard = defuseKeepalive(attach);
          try {
            await openedWithin(attach, ATTACH_TIMEOUT_MS);
          } catch (err) {
            guard();
            throw err;
          }
          if (done || killed) {
            guard();
            closeQuietly(attach);
            return;
          }
          latest = attach;
          stopKeepaliveGuard = guard;
          wire(attach, true);
          push({ kind: "stderr", data: "reattached to the running command" });
          return;
        } catch {
          // The sandbox is still unreachable; the next attempt decides.
        }
        const delay = REATTACH_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await sleep(delay);
      }
      conclude(
        -1,
        "the connection to the sandbox closed before the command reported an exit, and the sandbox stayed unreachable while the driver tried to reattach",
      );
    };

    const wire = (child: SpriteCommand, alreadyOpen: boolean) => {
      let retired = false;
      let open = alreadyOpen;
      let connectDeadline: NodeJS.Timeout | null = null;
      const retire = () => {
        retired = true;
        if (connectDeadline) clearTimeout(connectDeadline);
        if (active === child) active = null;
      };
      /**
       * The SDK's connect has no bound of its own: a connection that
       * blackholes emits neither open nor error, and the run would sit
       * silent until its own limit. Generous, because a hibernated
       * sprite wakes on demand and the wake rides this same connect.
       * Ending through lost() rather than a plain failure, because the
       * server may have started the command even though the answer
       * never arrived; the session listing settles which.
       */
      if (!alreadyOpen) {
        connectDeadline = setTimeout(() => {
          if (retired || open || done) return;
          retire();
          closeQuietly(child);
          push({ kind: "stderr", data: "the sandbox did not accept the connection in time" });
          lost(null);
        }, EXEC_CONNECT_TIMEOUT_MS);
        connectDeadline.unref?.();
      }
      const activate = () => {
        active = child;
        if (stdinDone) child.stdin.end();
        wakeStdin();
      };
      if (alreadyOpen) activate();
      child.on("spawn", () => {
        if (retired) return;
        open = true;
        activate();
      });
      child.stdout.on("data", (d: Buffer | string) => {
        if (!retired) push({ kind: "stdout", data: d.toString() });
      });
      child.stderr.on("data", (d: Buffer | string) => {
        if (!retired) push({ kind: "stderr", data: d.toString() });
      });
      child.on("error", (err: Error) => {
        if (retired) return;
        push({ kind: "stderr", data: scrubExecUrl(String(err)) });
        // A connection that never opened has no exit event coming, so
        // the error is its ending; an open one ends through exit.
        if (!open) {
          retire();
          lost(null);
        }
      });
      child.on("exit", (code: number | null) => {
        if (retired) return;
        retire();
        stopKeepaliveGuard();
        // A real process exit arrives as an unsigned byte, so a negative
        // or missing code here always means the socket closed without
        // one. Said out loud, because "exit code -1" reads as the agent
        // failing when the agent was never heard from at all.
        if (code === null || code < 0) {
          lost(code);
          return;
        }
        conclude(code);
      });
    };

    /**
     * The WebSocket kill only works while the socket does, so a stop is
     * also delivered over HTTP, which reaches the process no matter
     * what state the socket is in. Best effort: when even this cannot
     * land, the disconnect grace period is what finally reaps the
     * process. TERM first with a short escalation to KILL, so a CLI
     * that ignores the polite signal still dies.
     */
    const killOverHttp = async () => {
      try {
        const fresh = await this.client.getSprite(handle.externalId);
        const sessions = await fresh.listSessions();
        const mine = sessions
          .filter((s) => !s.tty && (s.command === command || s.command.startsWith(`${command} `)))
          .sort((a, b) => b.created.getTime() - a.created.getTime())[0];
        if (!mine) return;
        const stream = await fresh.killSession(mine.id, "SIGTERM", "10s");
        await stream.processAll(() => {});
      } catch {
        // The socket kill and the disconnect grace still bound the process.
      }
    };

    /**
     * A kill travels over the same WebSocket as the output, so a kill
     * sent on a dead connection is sent into the void and no exit event
     * ever comes back. Without a bound, the stream then waits forever
     * and the run holds its worker slot until the server restarts. The
     * reaper turns that into a failed run; the HTTP kill above and the
     * disconnect grace period bound the orphaned process itself.
     */
    let reap: NodeJS.Timeout | null = null;
    const kill = () => {
      killed = true;
      void latest?.kill();
      void killOverHttp();
      if (!reap) {
        reap = setTimeout(() => {
          conclude(-1, "the sandbox did not confirm the process ended after it was told to stop");
        }, 15_000);
        reap.unref?.();
      }
    };
    const onAbort = () => kill();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    // Named in the stream because a SIGTERM'd CLI exits without saying
    // why, and "stopped before reporting a result" hides that the
    // stopping was ours.
    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          push({
            kind: "stderr",
            data: `the run hit its ${Math.round(opts.timeoutMs! / 60_000)} minute limit and was stopped`,
          });
          kill();
        }, opts.timeoutMs)
      : null;

    const child = sprite.spawn(command, args, {
      cwd: opts?.cwd ?? handle.workdir,
      /**
       * IS_SANDBOX says the sandbox is the security boundary, which a
       * sprite is. Claude Code checks it before accepting
       * --dangerously-skip-permissions as root, and sprites run
       * commands as root; without it every claude-code run died at
       * exit 1 with no output. The Docker driver learned this the same
       * way (see docker.ts).
       */
      env: { IS_SANDBOX: "1", ...opts?.env },
      maxRunAfterDisconnect: EXEC_DISCONNECT_GRACE,
    });
    latest = child;
    stopKeepaliveGuard = defuseKeepalive(child);
    wire(child, false);

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
      done = true;
      wakeStdin();
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
   *
   * The stream reports failure as an error message rather than a
   * rejection, and draining it blind made a failed checkpoint look
   * exactly like a finished one: listCheckpoints would then hand back
   * the previous snapshot, and a later rollback would quietly restore
   * the wrong filesystem. The drain is also bounded, because the
   * checkpoint fetch carries no timeout at any layer and a stalled
   * stream parked the run in "starting" holding its worker slot.
   */
  async snapshot(handle: SandboxHandle, label: string): Promise<string> {
    const sprite = await this.client.getSprite(handle.externalId);
    const stream = await bounded(sprite.createCheckpoint(label), CHECKPOINT_TIMEOUT_MS, "the checkpoint");
    const failures: string[] = [];
    try {
      await bounded(
        stream.processAll((message) => {
          if (message.type === "error") failures.push(message.error ?? message.data ?? "unnamed error");
        }),
        CHECKPOINT_TIMEOUT_MS,
        "the checkpoint",
      );
    } finally {
      stream.close();
    }
    if (failures.length > 0) throw new Error(`checkpoint failed: ${failures.join("; ")}`);

    const checkpoints = await sprite.listCheckpoints();
    let newest: { id: string; createTime: Date } | undefined;
    for (const checkpoint of checkpoints) {
      if (!newest || checkpoint.createTime > newest.createTime) newest = checkpoint;
    }
    if (!newest) throw new Error("checkpoint was created but none is listed");
    return newest.id;
  }

  /**
   * Restores the sandbox filesystem to a checkpoint. Watched and
   * bounded the same way snapshot is: a restore that failed or stalled
   * while reporting nothing left the caller believing the rollback
   * happened.
   */
  async restore(handle: SandboxHandle, snapshotId: string): Promise<void> {
    const sprite = await this.client.getSprite(handle.externalId);
    const stream = await bounded(sprite.restoreCheckpoint(snapshotId), RESTORE_TIMEOUT_MS, "the restore");
    const failures: string[] = [];
    try {
      await bounded(
        stream.processAll((message) => {
          if (message.type === "error") failures.push(message.error ?? message.data ?? "unnamed error");
        }),
        RESTORE_TIMEOUT_MS,
        "the restore",
      );
    } finally {
      stream.close();
    }
    if (failures.length > 0) throw new Error(`restore failed: ${failures.join("; ")}`);
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
 *
 * Bounded, because defuseKeepalive removes the SDK's only half open
 * socket detector: without a deadline of its own, a connection that
 * died silently mid install left the promise unsettled and the run
 * parked in "starting" holding its worker slot until a restart.
 * Generous, for the same reason repo-setup's bound is: a cold
 * toolchain install is minutes, not seconds.
 */
const PROVISION_SCRIPT_TIMEOUT_MS = 20 * 60_000;

/**
 * How long the sprite keeps an exec'd process running after its socket
 * disconnects, passed on every exec so a reattach has something to
 * reattach to. Well past the reattach deadline below, and short enough
 * that a process nobody could reclaim does not run to the run limit:
 * this same window is what finally stops a process whose kill was sent
 * into a dead socket.
 */
const EXEC_DISCONNECT_GRACE = "10m";

/**
 * Waits between reattach attempts. Only transport failures walk this
 * ladder; a sandbox that answers but no longer lists the session is
 * conclusive on the first try. Roughly two minutes in total, chosen to
 * ride out the restarts and routing blips that take a socket down
 * without taking the sprite down, while staying well inside the
 * disconnect grace period.
 */
const REATTACH_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/** How long one attach attempt may sit connecting before the next tries. */
const ATTACH_TIMEOUT_MS = 30_000;

/**
 * How long the first connection of an exec may sit connecting. Longer
 * than an attach attempt, because a hibernated sprite wakes on demand
 * and the wake rides this connect.
 */
const EXEC_CONNECT_TIMEOUT_MS = 2 * 60_000;

/**
 * Bounds for SDK calls that carry no timeout of their own. The
 * checkpoint and restore fetches say so outright ("No timeout"), and
 * the filesystem calls simply never set one, so any of them could hang
 * a provision or snapshot forever with the run parked in "starting".
 */
const FILESYSTEM_TIMEOUT_MS = 5 * 60_000;
const CHECKPOINT_TIMEOUT_MS = 5 * 60_000;
const RESTORE_TIMEOUT_MS = 10 * 60_000;

/**
 * Races unbounded SDK work against a deadline. The underlying request
 * cannot be aborted from here (the SDK exposes no signal), so a bound
 * that fires abandons it: that costs a socket, where the hang it
 * replaces cost a worker slot until a server restart.
 */
function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`${what} did not finish within ${Math.round(ms / 60_000)} minutes`)),
      ms,
    );
    deadline.unref?.();
    work.then(
      (value) => {
        clearTimeout(deadline);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(deadline);
        reject(err);
      },
    );
  });
}

/** Resolves on the connection opening, rejects on its error or the deadline. */
function openedWithin(child: SpriteCommand, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("attach timed out")), ms);
    deadline.unref?.();
    child.once("spawn", () => {
      clearTimeout(deadline);
      resolve();
    });
    child.once("error", (err: Error) => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}

/**
 * Closes a connection the run no longer wants without signaling the
 * process behind it: kill() would deliver SIGTERM to the very process a
 * reattach was trying to keep. Reached by duck type like the keepalive
 * clock; the pin test covers the name.
 */
function closeQuietly(child: unknown): void {
  const ws = (child as { wsCmd?: { close?: () => void } }).wsCmd;
  ws?.close?.();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function runScript(
  sprite: Sprite,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = sprite.spawn("sh", ["-c", script]);
  const stopKeepaliveGuard = defuseKeepalive(child);
  feedStdin(child);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      stopKeepaliveGuard();
      clearTimeout(deadline);
      finish();
    };
    const deadline = setTimeout(() => {
      // The kill may be going to a dead socket, so nothing waits for
      // it to be confirmed; the reject is the bound.
      void child.kill();
      settle(() =>
        reject(
          Object.assign(
            new Error(
              `provisioning script did not finish within ${PROVISION_SCRIPT_TIMEOUT_MS / 60_000} minutes`,
            ),
            { stdout, stderr },
          ),
        ),
      );
    }, PROVISION_SCRIPT_TIMEOUT_MS);
    deadline.unref?.();
    child.stdout.on("data", (d: Buffer | string) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer | string) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => {
      settle(() => reject(err));
    });
    child.on("exit", (code: number | null) => {
      settle(() => {
        const exitCode = code ?? -1;
        if (exitCode !== 0) {
          // stdout and stderr ride on the error, the shape
          // run-executor's describeSandboxError reads to put installer
          // output in the run record.
          reject(
            Object.assign(new Error(`provisioning script failed with exit code ${exitCode}`), { stdout, stderr }),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  });
}

/**
 * Ends the spawned process's stdin once the connection is open, so the
 * process sees end-of-input.
 *
 * The SDK asks the server to open the command's stdin on every exec
 * (stdin=true on the URL) and only sends the end-of-input frame when
 * this side ends the stdin stream. An agent CLI treats a piped stdin
 * as input it must read before starting (opencode's run awaits stdin
 * to EOF), so a run whose stdin never closed produced not a single
 * event, indefinitely. The SDK's keepalive used to cut exactly those
 * runs off after 45 quiet seconds, which read as a websocket failure;
 * once defuseKeepalive turned that off, the same hang simply ran until
 * the run limit.
 *
 * On "spawn" rather than immediately, because the EOF frame is dropped
 * or refused while the socket is still connecting, and "spawn" fires
 * once it is open. Live agent sessions do not come through here: exec's
 * own stdin pump feeds them, because their lines must survive a
 * reattach and this binds to a single connection.
 */
function feedStdin(child: SpriteCommand): void {
  child.on("spawn", () => {
    child.stdin.end();
  });
}

/**
 * The SDK appends the exec URL to its connection errors, and that URL
 * carries the process's entire environment as query parameters,
 * credentials included. These strings end up in run transcripts, so
 * the URL must never survive into one.
 */
function scrubExecUrl(message: string): string {
  return message.replace(/wss?:\/\/\S+/g, "[sandbox exec url]");
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
