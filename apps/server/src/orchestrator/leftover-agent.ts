import type { ExecChunk, SandboxDriver, SandboxHandle } from "@bento/sandbox";

/**
 * What a task's machine held when a new run was about to start in it.
 *
 * "none": no agent of this command was still running. "stopped": one
 * was, and it is gone now. "running": one was, and it could not be
 * stopped, or the sandbox could not say, so a second agent must not
 * be started beside it.
 */
export type LeftoverAgent = "none" | "stopped" | "running";

/** How long a told-to-stop agent gets to exit before it counts as still running. */
export const LEFTOVER_AGENT_STOP_MS = 30_000;

/**
 * Stops an agent an earlier run of the same task left running in its
 * machine, before another one is started there.
 *
 * One task, one agent, is what the database enforces, but only over
 * run rows. A restart that could not reattach closes its run as
 * interrupted and leaves the process alone, so the agent can go on
 * committing to the task's branch while the row says nothing is
 * running, and the next run would start a second agent beside it.
 * Only a task's own machine is asked, because nothing else ever runs
 * an agent there: a machine shared by several runs could hold one
 * that is legitimately still working.
 *
 * The same door a resume uses: attach finds the session by the
 * command, and aborting the attached stream kills it on every driver
 * that has attach. A second attach then confirms nothing is left.
 * Every command an earlier run of the task could have started is
 * asked about, because a leaf reassigned to another agent leaves the
 * old one's process under another name. A question the sandbox could
 * not answer, after a few tries, counts as "running": better a run
 * that waits for the coordinator to try again than two agents on one
 * branch.
 */
export async function stopLeftoverAgent(
  driver: Pick<SandboxDriver, "attach">,
  handle: SandboxHandle,
  commands: string[][],
  options: { stopMs?: number; attachRetryMs?: number } = {},
): Promise<LeftoverAgent> {
  if (!driver.attach) return "none";
  let stopped = false;
  for (const argv of commands) {
    const outcome = await stopOne(driver as Required<Pick<SandboxDriver, "attach">>, handle, argv, options);
    if (outcome === "running") return "running";
    if (outcome === "stopped") stopped = true;
  }
  return stopped ? "stopped" : "none";
}

/**
 * How many times a question the sandbox could not answer is asked
 * again before it counts as "running". A provider blip at the start
 * of a run would otherwise fail it, and three of those in a row hand a
 * healthy task to the planner.
 */
const ATTACH_ATTEMPTS = 3;

async function stopOne(
  driver: Required<Pick<SandboxDriver, "attach">>,
  handle: SandboxHandle,
  argv: string[],
  options: { stopMs?: number; attachRetryMs?: number },
): Promise<LeftoverAgent> {
  const stopMs = options.stopMs ?? LEFTOVER_AGENT_STOP_MS;
  const controller = new AbortController();
  const stream = await attachWithRetry(
    () => driver.attach(handle, argv, { signal: controller.signal, timeoutMs: stopMs }),
    options.attachRetryMs ?? 2_000,
  );
  if (stream === "unanswered") return "running";
  if (!stream) return "none";

  controller.abort();
  const exited = await drainUntilExit(stream, stopMs);
  if (!exited) return "running";
  const again = await attachWithRetry(() => driver.attach(handle, argv, { timeoutMs: stopMs }), options.attachRetryMs ?? 2_000);
  if (again === "unanswered") return "running";
  if (!again) return "stopped";
  // Still there: let go of the connection and say so.
  void Promise.resolve(again[Symbol.asyncIterator]().return?.()).catch(() => {});
  return "running";
}

async function attachWithRetry(
  attach: () => Promise<AsyncIterable<ExecChunk> | null>,
  retryMs: number,
): Promise<AsyncIterable<ExecChunk> | null | "unanswered"> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attach();
    } catch {
      if (attempt >= ATTACH_ATTEMPTS) return "unanswered";
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/** Reads a stream until its exit, for at most `ms`. True when it exited. */
async function drainUntilExit(stream: AsyncIterable<ExecChunk>, ms: number): Promise<boolean> {
  const iterator = stream[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const read = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done || next.value.kind === "exit") return true;
    }
  })().catch(() => false);
  const exited = await Promise.race([read, timedOut]);
  clearTimeout(timer);
  // Let go of a connection that never reached its exit.
  if (!exited) void Promise.resolve(iterator.return?.()).catch(() => {});
  return exited;
}
