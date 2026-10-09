import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecChunk, ExecOptions, SandboxDriver, SandboxHandle } from "@bento/sandbox";
import { stopLeftoverAgent } from "./leftover-agent.js";

const handle: SandboxHandle = { externalId: "bento-swarm-1-task", provider: "modal", workdir: "/workspace" };
const argv = ["claude", "-p"];

/** An agent process the fake sandbox holds until it is aborted, or forever when `stubborn`. */
function sandboxWithAgent(options: { stubborn?: boolean } = {}) {
  let running = true;
  const attaches: string[] = [];
  const driver: Pick<SandboxDriver, "attach"> = {
    async attach(_handle: SandboxHandle, command: string[], opts?: ExecOptions) {
      attaches.push(command[0]!);
      if (!running) return null;
      return (async function* (): AsyncGenerator<ExecChunk> {
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) resolve();
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (options.stubborn) await new Promise(() => {});
        running = false;
        yield { kind: "exit", exitCode: 143 };
      })();
    },
  };
  return { driver, attaches, get running() { return running; } };
}

test("an agent an earlier run left behind is stopped, and the stop is confirmed", async () => {
  const sandbox = sandboxWithAgent();
  assert.equal(await stopLeftoverAgent(sandbox.driver, handle, [argv]), "stopped");
  assert.equal(sandbox.running, false);
  assert.deepEqual(sandbox.attaches, ["claude", "claude"], "asked once to stop it and once to confirm");
});

test("a machine with no agent in it is left alone", async () => {
  const driver: Pick<SandboxDriver, "attach"> = { attach: async () => null };
  assert.equal(await stopLeftoverAgent(driver, handle, [argv]), "none");
  assert.equal(await stopLeftoverAgent({}, handle, [argv]), "none", "a driver that cannot attach has nothing to find");
});

test("an agent that will not stop, or a sandbox that cannot say, means no second agent", async () => {
  const stubborn = sandboxWithAgent({ stubborn: true });
  assert.equal(await stopLeftoverAgent(stubborn.driver, handle, [argv], { stopMs: 50 }), "running");

  const unreachable: Pick<SandboxDriver, "attach"> = {
    attach: async () => {
      throw new Error("connection refused");
    },
  };
  assert.equal(await stopLeftoverAgent(unreachable, handle, [argv], { attachRetryMs: 1 }), "running");
});

test("a blip is asked about again before it counts as a running agent", async () => {
  let calls = 0;
  const flaky: Pick<SandboxDriver, "attach"> = {
    attach: async () => {
      calls += 1;
      if (calls === 1) throw new Error("502 from the provider");
      return null;
    },
  };
  assert.equal(await stopLeftoverAgent(flaky, handle, [argv], { attachRetryMs: 1 }), "none");
  assert.equal(calls, 2);
});

test("an agent left by another CLI is found under its own command", async () => {
  const sandbox = sandboxWithAgent();
  const onlyCodex: Pick<SandboxDriver, "attach"> = {
    attach: (h, command, opts) => (command[0] === "codex" ? sandbox.driver.attach!(h, command, opts) : Promise.resolve(null)),
  };
  assert.equal(await stopLeftoverAgent(onlyCodex, handle, [argv, ["codex"]]), "stopped");
  assert.equal(sandbox.running, false);
});
