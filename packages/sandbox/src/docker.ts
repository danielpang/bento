import type Docker from "dockerode";
import { createDockerClient } from "./docker-client.js";
import type { ExecChunk, ExecOptions, ProvisionSpec, SandboxDriver, SandboxHandle } from "./driver.js";

const DEFAULT_IMAGE = "bento-sandbox:dev";

/** Maps host.docker.internal to the host, so a sandbox can reach the gateway. */
export const HOST_GATEWAY_ALIAS = "host.docker.internal:host-gateway";

/**
 * One container per feature. The feature's git worktree is bind-mounted at
 * /workspace. The container runs as a long-lived sleep process; each agent
 * run is a docker exec inside it, so state (installed deps, caches)
 * persists across stage runs for the feature.
 */
export class DockerDriver implements SandboxDriver {
  /**
   * The Docker network to attach locked down sandboxes to. Named by the
   * operator (BENTO_SANDBOX_RESTRICTED_NETWORK) because the egress
   * rules live on the network, not here: Docker alone cannot express
   * "reach the model provider and nothing else".
   */
  private restrictedNetwork: string | undefined;
  provider = "docker" as const;
  supportsStdin = true;
  private docker: Docker;

  constructor(docker?: Docker, restrictedNetwork?: string) {
    this.docker = docker ?? createDockerClient();
    this.restrictedNetwork = restrictedNetwork;
  }

  /** Only when the operator has named a network to use for it. */
  get supportsRestrictedNetwork(): boolean {
    return Boolean(this.restrictedNetwork);
  }

  containerName(featureId: string): string {
    return `bento-sbx-${featureId}`;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const name = this.containerName(spec.featureId);
    const image = spec.image ?? DEFAULT_IMAGE;
    const binds = [
      `${spec.hostWorkspacePath}:/workspace`,
      ...(spec.mounts ?? []).map(
        (m) => `${m.hostPath}:${m.containerPath}${m.readOnly === false ? "" : ":ro"}`,
      ),
    ];

    const existing = this.docker.getContainer(name);
    try {
      const info = await existing.inspect();
      // A container built before the gateway host alias existed cannot
      // reach the MCP gateway, and HostConfig is immutable after create,
      // so a stale one is rebuilt rather than reused. Binds are the
      // durable state; recreation already happens on a bind change.
      const hasGatewayHost = (info.HostConfig?.ExtraHosts ?? []).includes(HOST_GATEWAY_ALIAS);
      if (hasGatewayHost && sameBinds(info.HostConfig?.Binds ?? [], binds)) {
        if (!info.State.Running) await existing.start();
        return { externalId: info.Id, provider: "docker", workdir: "/workspace" };
      }
      // Built for mounts that are no longer the truth: a data directory
      // move, a credential-sharing change. Reusing it would put the
      // agent in an old workspace with old credentials and no error
      // anywhere, so it is rebuilt. Installed deps are lost; they
      // belonged to a configuration that no longer exists.
      await existing.remove({ force: true });
    } catch {
      // Not found; create it.
    }

    const container = await this.docker.createContainer({
      name,
      Image: image,
      Cmd: ["sleep", "infinity"],
      Labels: {
        "dev.bento.project": spec.projectId,
        "dev.bento.feature": spec.featureId,
      },
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      WorkingDir: "/workspace",
      HostConfig: {
        Binds: binds,
        // Lets a sandbox reach the MCP gateway when it runs on the host
        // loopback. It maps only host.docker.internal, which the
        // orchestrator points at the gateway URL; it does not widen what
        // else the sandbox can dial beyond what the network already allows.
        ExtraHosts: [HOST_GATEWAY_ALIAS],
        // Modest defaults; agent profiles can raise these later.
        Memory: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        /**
         * An organization that locked its agents down runs them on the
         * deployment's restricted network, whose egress rules are the
         * operator's to define. Without one configured, provisioning
         * has already refused: a security setting that silently does
         * nothing is worse than one that is off.
         */
        ...(spec.network === "restricted" && this.restrictedNetwork
          ? { NetworkMode: this.restrictedNetwork }
          : {}),
      },
    });
    await container.start();
    const info = await container.inspect();
    return { externalId: info.Id, provider: "docker", workdir: "/workspace" };
  }

  async *exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const container = this.docker.getContainer(handle.externalId);
    const exec = await container.exec({
      Cmd: argv,
      AttachStdin: opts?.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts?.cwd ?? handle.workdir,
      /**
       * IS_SANDBOX says the container is the security boundary, which
       * is this image's whole design. Claude Code checks it before
       * accepting --dangerously-skip-permissions as root; without it
       * every claude-code run in a container died at exit 1 with no
       * output, because the sandbox image runs as root.
       */
      Env: ["IS_SANDBOX=1", ...Object.entries(opts?.env ?? {}).map(([k, v]) => `${k}=${v}`)],
    });
    const stream = await exec.start({ hijack: true, stdin: opts?.stdin !== undefined });

    // Live sessions: lines pushed by the executor flow into the
    // process; the iterable ending is end-of-input, which is how the
    // agent learns the conversation is over.
    if (opts?.stdin) {
      void (async () => {
        try {
          for await (const line of opts.stdin!) {
            stream.write(line.endsWith("\n") ? line : `${line}\n`);
          }
        } catch {
          // The stream died first; the exit chunk tells the story.
        } finally {
          try {
            stream.end();
          } catch {
            // Already closed.
          }
        }
      })();
    }

    const queue: ExecChunk[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    const push = (chunk: ExecChunk) => {
      queue.push(chunk);
      notify?.();
    };

    // Docker multiplexes stdout/stderr over one stream; demux into chunks.
    const stdout = new CollectingStream((data) => push({ kind: "stdout", data }));
    const stderr = new CollectingStream((data) => push({ kind: "stderr", data }));
    this.docker.modem.demuxStream(stream, stdout, stderr);

    stream.on("end", async () => {
      try {
        const info = await exec.inspect();
        push({ kind: "exit", exitCode: info.ExitCode ?? -1 });
      } catch (err) {
        push({ kind: "stderr", data: String(err) });
        push({ kind: "exit", exitCode: -1 });
      }
      done = true;
      notify?.();
    });
    stream.on("error", (err: Error) => {
      push({ kind: "stderr", data: String(err) });
      push({ kind: "exit", exitCode: -1 });
      done = true;
      notify?.();
    });

    const onAbort = () => stream.destroy(new Error("cancelled"));
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          stream.destroy(new Error("exec timeout"));
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
   * Runs `command -v` for each tool in a throwaway container built from
   * the sandbox image, which is where agents actually run: what the
   * server's own machine has is beside the point.
   */
  async checkTools(binaries: readonly string[], image?: string): Promise<Record<string, boolean> | null> {
    // Names arrive as arguments rather than inside the script, so no
    // tool name can ever be read as shell.
    const script = 'for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 && echo "$tool"; done';
    let container;
    try {
      container = await this.docker.createContainer({
        Image: image ?? DEFAULT_IMAGE,
        Cmd: ["sh", "-lc", script, "sh", ...binaries],
        // A TTY gives the log back unframed, which saves demuxing four
        // words of output.
        Tty: true,
      });
    } catch {
      // No such image, or no daemon. Unanswerable, not "missing".
      return null;
    }
    try {
      await container.start();
      await container.wait();
      const logs = await container.logs({ stdout: true, stderr: false });
      const found = new Set(String(logs).split(/\s+/).filter(Boolean));
      return Object.fromEntries(binaries.map((binary) => [binary, found.has(binary)]));
    } catch {
      return null;
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const container = this.docker.getContainer(handle.externalId);
    try {
      await container.remove({ force: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }
}

/**
 * Same mounts, order aside. Docker reports Binds as they were given at
 * creation, and both sides here are produced by the same generator, so
 * string set equality is the honest comparison.
 */
export function sameBinds(actual: string[], wanted: string[]): boolean {
  if (actual.length !== wanted.length) return false;
  const have = new Set(actual);
  return wanted.every((b) => have.has(b));
}

import { Writable } from "node:stream";

class CollectingStream extends Writable {
  constructor(private onData: (data: string) => void) {
    super();
  }
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.onData(chunk.toString("utf8"));
    cb();
  }
}
