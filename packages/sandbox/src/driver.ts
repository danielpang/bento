export interface SandboxHandle {
  /** Driver-specific identifier: container id, sprite name, or process tag. */
  externalId: string;
  provider: "docker" | "sprite" | "local-process";
  /** Working directory inside the sandbox where the repo is checked out. */
  workdir: string;
}

export interface ProvisionSpec {
  projectId: string;
  featureId: string;
  /** Host path of the git worktree to expose at workdir (docker/local). */
  hostWorkspacePath: string;
  /**
   * Repositories to make available. Drivers with no host filesystem to
   * mount (Sprites) clone these instead of using hostWorkspacePath.
   */
  repositories?: {
    name: string;
    cloneUrl?: string | undefined;
    branch?: string | undefined;
    baseBranch?: string | undefined;
    /** Trusted server-created bundle used when credentials cannot enter the sandbox. */
    seedBundle?: Buffer | undefined;
  }[];
  /**
   * Whether this sandbox may reach the network.
   *
   * "restricted" means the deployment's locked down network, which it
   * must have configured; a driver that cannot honour it refuses to
   * provision rather than quietly running with open egress. Absent
   * means open, which is the default everywhere.
   */
  network?: "open" | "restricted";
  /**
   * Extra paths to expose inside the sandbox. Used in local mode to
   * share the user's own agent logins, so a subscription they already
   * pay for works without a separate API key.
   */
  mounts?: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  image?: string;
  env?: Record<string, string>;
  /**
   * Called with a human readable line as provisioning advances: sandbox
   * created, tools installed, repository cloned. Provisioning a cold
   * sandbox takes minutes, and without these lines the run just reads
   * "starting" with no way to tell progress from a hang. Drivers await
   * each call so the lines land in order; a driver with nothing slow to
   * report may ignore it.
   */
  onProgress?: (message: string) => void | Promise<void>;
}

export type ExecChunk =
  | { kind: "stdout"; data: string }
  | { kind: "stderr"; data: string }
  | { kind: "exit"; exitCode: number };

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Aborting kills the process, which is how a run is cancelled. */
  signal?: AbortSignal;
  /**
   * Lines to feed the process on stdin while it runs, for agents that
   * hold a live session open. The iterable ending closes stdin, which
   * is how such an agent is told the conversation is over. Only
   * drivers that report supportsStdin honor this.
   */
  stdin?: AsyncIterable<string>;
}

/**
 * A push-driven line channel bridging "a message arrived" to a
 * process's stdin. The executor writes; the driver consumes it as the
 * ExecOptions.stdin iterable. One writer, one reader, tiny on purpose.
 */
export class LineChannel implements AsyncIterable<string> {
  private queue: string[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  /** Queues a line for stdin. Returns false once the channel is closed. */
  write(line: string): boolean {
    if (this.closed) return false;
    this.queue.push(line);
    this.notify?.();
    return true;
  }

  /** No further lines: the process sees end-of-input. */
  end(): void {
    this.closed = true;
    this.notify?.();
  }

  /** Lines waiting that the process has not consumed yet. */
  get pending(): number {
    return this.queue.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
      this.notify = null;
    }
  }
}

export interface RepositoryBundle {
  /** Commit the feature branch started from inside the sandbox. */
  baseSha: string;
  /** Commit produced by the agent. */
  headSha: string;
  /** Git bundle containing objects reachable from head but not base. */
  data: Buffer;
}

/**
 * One sandbox per feature. The sandbox is the security boundary: agents run
 * inside it with permission checks disabled, so drivers must never expose
 * the host Docker socket, host SSH keys, or host git config to the sandbox.
 */
export interface SandboxDriver {
  provider: SandboxHandle["provider"];
  /** Whether exec honors ExecOptions.stdin. Live agent sessions need it. */
  supportsStdin?: boolean;
  provision(spec: ProvisionSpec): Promise<SandboxHandle>;
  /**
   * Whether this driver can put a sandbox on a network with no route
   * out. Read before provisioning, so an organization that asked for
   * it is told plainly rather than silently given open egress.
   */
  readonly supportsRestrictedNetwork?: boolean;
  exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk>;
  /**
   * Which of these executables a sandbox here would actually have.
   *
   * Asked before a run rather than during one: picking a coding agent
   * this machine cannot start is a mistake worth catching in the form,
   * not at the end of a queued run. Null means the question could not
   * be answered (no image built yet, daemon unreachable), which is
   * different from "not installed" and must not be shown as it.
   */
  checkTools?(binaries: readonly string[], image?: string): Promise<Record<string, boolean> | null>;
  destroy(handle: SandboxHandle): Promise<void>;
  /**
   * Point-in-time snapshot of the sandbox, taken before an agent runs so
   * its changes can be undone wholesale. Only drivers that can restore
   * implement this; the Docker driver relies on git instead.
   */
  snapshot?(handle: SandboxHandle, label: string): Promise<string>;
  restore?(handle: SandboxHandle, snapshotId: string): Promise<void>;
  /**
   * Exports committed work without putting a remote credential inside
   * the sandbox. Drivers whose repositories live on the host do not
   * need this; publishing can read their worktrees directly.
   */
  exportRepository?(
    handle: SandboxHandle,
    repositoryName: string,
    baseBranch: string,
  ): Promise<RepositoryBundle | null>;
}

/** Collects an exec stream into buffered output. Convenience for tests and gates. */
export async function collectExec(
  stream: AsyncIterable<ExecChunk>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  for await (const chunk of stream) {
    if (chunk.kind === "stdout") stdout += chunk.data;
    else if (chunk.kind === "stderr") stderr += chunk.data;
    else exitCode = chunk.exitCode;
  }
  return { stdout, stderr, exitCode };
}
