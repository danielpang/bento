import { randomUUID } from "node:crypto";
import type { Sprite } from "@fly/sprites";

/**
 * Holds a Sprite awake for as long as a command is running on it.
 *
 * A Sprite pauses when it looks idle, and what it counts as activity is
 * output: a process started through exec keeps the machine up only
 * while it is writing. A coding agent waiting on a model turn writes
 * nothing for minutes at a time, so the machine underneath it pauses,
 * and a pause ends every process exec started. Only Services survive
 * one.
 *
 * That is not a connection problem, so none of the connection level
 * machinery in sprite.ts can see it. The socket drop it causes looks
 * exactly like a routing blip, the driver reattaches as designed, and
 * the session listing comes back without the agent, because the agent
 * is genuinely gone. A whole run died that way half an hour in, and the
 * only trace was `exit code -1` with the driver's own reattach note in
 * the tail.
 *
 * The Tasks API is the platform's answer: while at least one task is
 * live the Sprite runs. It lives on the machine's own management socket
 * rather than the public API, so the only way to reach it is to run a
 * command inside the sandbox, which is what this does.
 *
 * Not to be confused with defuseKeepalive in sprite.ts. That one stops
 * the SDK from declaring a quiet *socket* dead; this one stops the
 * platform from pausing the quiet *machine*. Both exist because an
 * agent that is thinking looks idle to everything that measures bytes,
 * and the two failures used to arrive looking identical.
 */

/**
 * How long a task outlives its last refresh.
 *
 * This is the blast radius of a server that dies mid run: the sandbox
 * stays awake, and billed, for this long after nobody is left to
 * release it. A task expires on its own precisely so a crash cannot
 * pin a machine awake forever, so this must stay short enough to be an
 * acceptable overrun and long enough to ride out a few missed
 * refreshes. The platform caps a single task at an hour regardless.
 */
const TASK_EXPIRE = "5m";

/**
 * How often the hold is renewed. Well inside TASK_EXPIRE, so four
 * refreshes in a row have to fail before a live run loses its hold.
 */
const REFRESH_MS = 60_000;

/**
 * Bound on one refresh call, so a management socket that stops
 * answering cannot pile requests up behind each other for the length
 * of a run.
 */
const CALL_TIMEOUT_MS = 30_000;

/** A live hold. Releasing is idempotent. */
export interface AwakeHold {
  /** The task's name inside the sandbox, for logs and tests. */
  readonly taskName: string;
  release(): void;
}

/**
 * Registers a task inside the sandbox and keeps refreshing it until the
 * hold is released.
 *
 * Best effort by construction: this runs alongside real work, and a
 * management socket that refuses must never be the reason a run fails.
 * Every call is swallowed. The cost of that is silence when the whole
 * mechanism is unavailable, so the first failure is reported once to
 * the server log, and sprite.e2e.test.ts holds a real machine awake
 * through a quiet stretch to prove the mechanism still works at all. A
 * stub cannot fail this the way a platform can.
 */
export function holdSpriteAwake(sprite: Sprite, label = "run"): AwakeHold {
  const taskName = `bento-${sanitize(label)}-${randomUUID().slice(0, 8)}`;
  let released = false;
  let warned = false;

  /**
   * Every call goes on one chain, so a release that lands while the
   * registration is still in flight still deletes the task that
   * registration creates. Unchained, the delete could win the race and
   * the sandbox would stay awake, and billed, until the task expired.
   */
  let chain: Promise<void> = Promise.resolve();
  const queue = (what: string, script: string): Promise<void> => {
    chain = chain.then(async () => {
      try {
        await sprite.execFileHTTP("sh", ["-c", script], { timeout: CALL_TIMEOUT_MS });
      } catch (err) {
        /**
         * Once per hold, not once per refresh: a sandbox whose Tasks
         * API is unreachable would otherwise print a line a minute for
         * the length of every run. To the server log rather than to
         * the run's stream, because agent output is a transcript the
         * user reads and this is an operator's problem.
         */
        if (!warned) {
          warned = true;
          console.warn(
            `could not ${what} the keep-awake task on ${sprite.name}; it may pause mid run:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    });
    return chain;
  };

  void queue("register", taskRequest("POST", "/v1/tasks", { name: taskName, expire: TASK_EXPIRE }));

  const timer = setInterval(() => {
    if (released) return;
    // PUT renews a task that is still there; the POST behind it covers
    // the one case a renewal cannot, which is a task that already
    // expired because refreshes were failing while the run continued.
    void queue(
      "refresh",
      `${taskRequest("PUT", `/v1/tasks/${taskName}`, { expire: TASK_EXPIRE })} || ${taskRequest("POST", "/v1/tasks", {
        name: taskName,
        expire: TASK_EXPIRE,
      })}`,
    );
  }, REFRESH_MS);
  timer.unref?.();

  return {
    taskName,
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      // Queued rather than sent, so it lands after the registration it
      // is undoing. The expiry is the backstop when even this cannot
      // land, which is why a hold is never the only thing standing
      // between a finished run and a paused machine.
      void queue("release", taskRequest("DELETE", `/v1/tasks/${taskName}`));
    },
  };
}

/**
 * One management socket call, as a shell command.
 *
 * `sprite-env curl` is the documented shorthand that knows the socket
 * path and the virtual host. It is a convenience of the sandbox image
 * rather than a guarantee, so the explicit form it stands for is
 * spelled out behind it: an image without the shim then still holds its
 * machine awake instead of silently losing every run to a pause.
 *
 * `-f` so an HTTP error is a non-zero exit rather than a body nobody
 * reads, which is what makes a refused call visible to the caller.
 *
 * Exported for sprite.e2e.test.ts, which runs exactly these requests
 * against a real machine's management socket. Every detail of this
 * shape came from documentation rather than from a live sandbox, and a
 * wrong one fails silently by design: the run continues, the hold never
 * takes, and the pause comes back. Only a real machine can say the
 * shape is right, so the test that asks it runs the production builder
 * rather than a copy of it.
 */
export function taskRequest(method: string, path: string, body?: Record<string, string>): string {
  const args = ["-fsS", "-X", method];
  if (body) args.push("-H", quote("Content-Type: application/json"), "-d", quote(JSON.stringify(body)));
  const flags = args.join(" ");
  return (
    `{ if command -v sprite-env >/dev/null 2>&1; then ` +
    `sprite-env curl ${flags} ${path}; ` +
    `else ` +
    `curl ${flags} --unix-socket /.sprite/api.sock -H ${quote("Host: sprite")} http://sprite${path}; ` +
    `fi; }`
  );
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Task names are interpolated into a shell command and a URL path, so
 * they are held to characters that mean nothing in either. The label
 * is ours in every current caller; this is here so that stays true of
 * a caller that passes something it read from a row.
 */
function sanitize(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 24) || "run";
}
