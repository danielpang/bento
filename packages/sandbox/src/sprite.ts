import { SpritesClient, type Sprite } from "@fly/sprites";
import { AGENT_BINARIES, AGENT_TOOLCHAIN_SCRIPT } from "./agent-toolchain.js";
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

    let sprite: Sprite;
    try {
      sprite = await this.client.getSprite(name);
    } catch {
      sprite = await this.client.createSprite(name, {
        ramMB: this.options.ramMB ?? 4096,
        cpus: this.options.cpus ?? 2,
        ...(this.options.region ? { region: this.options.region } : {}),
      } as Parameters<SpritesClient["createSprite"]>[1]);
    }

    await runScript(sprite, `mkdir -p ${shellQuote(this.workdir)}`);

    /**
     * A sprite is a bare machine, not an image: there is nowhere to bake
     * the agent CLIs the way the Docker driver does, so they are
     * installed on first provision. The script exits at once when the
     * marker is already there, which is every stage after a card's
     * first.
     */
    await runScript(sprite, AGENT_TOOLCHAIN_SCRIPT);

    // Repositories live inside the sprite, so clone what is missing and
    // fetch what is already there.
    for (const repo of spec.repositories ?? []) {
      if (!repo.cloneUrl) continue;
      const dir = `${this.workdir}/${repo.name}`;
      const branch = repo.branch ?? "main";
      const baseBranch = repo.baseBranch ?? "main";
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

    const onAbort = () => void child.kill();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          void child.kill();
        }, opts.timeoutMs)
      : null;

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
      if (timeout) clearTimeout(timeout);
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
 */
function runScript(sprite: Sprite, script: string) {
  return sprite.execFile("sh", ["-c", script]);
}

/** Minimal POSIX single-quote escaping for interpolated paths and URLs. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuotePart(value: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("unsafe git reference");
  return value;
}
