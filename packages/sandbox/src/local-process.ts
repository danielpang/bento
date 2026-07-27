import { spawn } from "node:child_process";
import type { ExecChunk, ExecOptions, ProvisionSpec, SandboxDriver, SandboxHandle } from "./driver.js";

/**
 * Runs commands as plain host processes in the feature's worktree.
 * NO isolation: intended for tests (fake adapter) and for users who
 * explicitly opt out of Docker. Never pair with skip-permissions flags
 * on real agent CLIs outside CI.
 */
export class LocalProcessDriver implements SandboxDriver {
  provider = "local-process" as const;
  supportsStdin = true;

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    return {
      externalId: `local-${spec.featureId}`,
      provider: "local-process",
      workdir: spec.hostWorkspacePath,
    };
  }

  /**
   * There is no sandbox here, so the question is simply what is on this
   * machine's PATH. A login shell, because that is where the agent
   * installers put themselves.
   */
  async checkTools(binaries: readonly string[]): Promise<Record<string, boolean> | null> {
    const entries = await Promise.all(
      binaries.map(
        (binary) =>
          new Promise<[string, boolean]>((resolve) => {
            // The name is an argument, never part of the script: a
            // shell needs to run at all only because command -v is a
            // builtin.
            const probe = spawn("sh", ["-lc", 'command -v "$1"', "sh", binary], { stdio: "ignore" });
            probe.on("error", () => resolve([binary, false]));
            probe.on("close", (code) => resolve([binary, code === 0]));
          }),
      ),
    );
    return Object.fromEntries(entries);
  }

  async *exec(handle: SandboxHandle, argv: string[], opts?: ExecOptions): AsyncIterable<ExecChunk> {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("empty argv");
    const child = spawn(cmd, args, {
      cwd: opts?.cwd ?? handle.workdir,
      env: { ...process.env, ...opts?.env },
      stdio: [opts?.stdin ? "pipe" : "ignore", "pipe", "pipe"] as ["pipe" | "ignore", "pipe", "pipe"],
    });

    // Live sessions: executor-pushed lines flow into the process, and
    // the iterable ending closes stdin, which ends the conversation.
    if (opts?.stdin && child.stdin) {
      const input = child.stdin;
      void (async () => {
        try {
          for await (const line of opts.stdin!) {
            input.write(line.endsWith("\n") ? line : `${line}\n`);
          }
        } catch {
          // Process died first; the exit chunk tells the story.
        } finally {
          input.end();
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

    // stdout/stderr are always "pipe" above; only stdin varies.
    child.stdout!.on("data", (d: Buffer) => push({ kind: "stdout", data: d.toString("utf8") }));
    child.stderr!.on("data", (d: Buffer) => push({ kind: "stderr", data: d.toString("utf8") }));
    child.on("error", (err) => {
      push({ kind: "stderr", data: String(err) });
      push({ kind: "exit", exitCode: 127 });
      done = true;
      notify?.();
    });
    child.on("close", (code) => {
      push({ kind: "exit", exitCode: code ?? -1 });
      done = true;
      notify?.();
    });

    // Cancelling a run aborts here, which kills the child the same way a
    // timeout does.
    const onAbort = () => child.kill("SIGTERM");
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeout = opts?.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
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
      if (!done) child.kill("SIGKILL");
    }
  }

  async destroy(): Promise<void> {
    // Nothing persistent to clean up.
  }
}
