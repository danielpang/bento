import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DockerDriver, SANDBOX_STOPPED_MESSAGE } from "./docker.js";
import { createDockerClient } from "./docker-client.js";
import { collectExec, LineChannel, type ExecChunk } from "./driver.js";

// Uses only the installed sandbox image, no agent credentials or network.
test(
  "Docker stops timed-out and cancelled execs without stopping unrelated commands",
  {
    skip: process.env.BENTO_DOCKER_E2E !== "1",
    timeout: 120000,
  },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "bento-exec-test-"));
    const docker = createDockerClient();
    const driver = new DockerDriver(docker, "none");
    const handle = await driver.provision({
      projectId: "exec-test",
      workspaceKey: `exec-test-${randomUUID()}`,
      hostWorkspacePath: directory,
      network: "restricted",
    });
    try {
      const unrelated = await docker.getContainer(handle.externalId).exec({ Cmd: ["sleep", "300"] });
      const detached = await unrelated.start({ Detach: true });
      detached.resume();
      const argv = [
        "sh",
        "-c",
        `
echo parent:$$
setsid sh -c 'echo detached:$$; sleep 300' &
sleep 300 &
wait
`,
      ];
      const assertStopped = async (stdout: string) => {
        const pids = [...stdout.matchAll(/(?:parent|detached):(\d+)/g)].map((match) => match[1]!);
        assert.equal(pids.length, 2, stdout);
        const status = await collectExec(driver.exec(handle, ["ps", "-eo", "pid,stat"]));
        for (const pid of pids) {
          const line = status.stdout.split("\n").find((line) => line.trim().split(/\s+/)[0] === pid);
          assert.ok(!line || line.trim().split(/\s+/)[1]!.startsWith("Z"), `process still running: ${line}`);
        }
        assert.equal((await unrelated.inspect()).Running, true, "other execs must survive");
      };
      await t.test("timeout kills the parent and detached child", async () => {
        const result = await collectExec(driver.exec(handle, argv, { timeoutMs: 800 }));
        assert.equal(result.exitCode, -1);
        assert.match(result.stderr, /exec timeout/);
        await assertStopped(result.stdout);
      });
      await t.test("abort kills the parent and detached child", async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 800);
        try {
          const result = await collectExec(driver.exec(handle, argv, { signal: controller.signal }));
          assert.equal(result.exitCode, -1);
          assert.match(result.stderr, /cancelled/);
          await assertStopped(result.stdout);
        } finally {
          clearTimeout(timer);
        }
      });
      await t.test("an already aborted command never starts", async () => {
        const result = await collectExec(
          driver.exec(handle, ["touch", "/workspace/should-not-exist"], {
            signal: AbortSignal.abort(),
          }),
        );
        assert.equal(result.exitCode, -1);
        assert.equal(
          (await collectExec(driver.exec(handle, ["test", "!", "-e", "/workspace/should-not-exist"])))
            .exitCode,
          0,
        );
      });
      await t.test("closing the iterator stops its still-running processes", async () => {
        let stdout = "";
        for await (const chunk of driver.exec(handle, argv)) {
          if (chunk.kind === "stdout") stdout += chunk.data;
          if (stdout.includes("parent:") && stdout.includes("detached:")) break;
        }
        await assertStopped(stdout);
      });
      await t.test("stdin and literal arguments still reach the command", async () => {
        const stdin = new LineChannel();
        stdin.write("café $HOME `literal`\nsecond line");
        stdin.end();
        const result = await collectExec(driver.exec(handle, ["cat"], { stdin, timeoutMs: 5000 }));
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "café $HOME `literal`\nsecond line\n");
        const literal = await collectExec(
          driver.exec(handle, ["printf", "%s", "$(touch /workspace/unwanted)"], { timeoutMs: 5000 }),
        );
        assert.equal(literal.stdout, "$(touch /workspace/unwanted)");
        assert.equal(
          (await collectExec(driver.exec(handle, ["test", "!", "-e", "/workspace/unwanted"]))).exitCode,
          0,
        );
      });
      await t.test("a detached agent keeps working and a new driver reads only missing output", async () => {
        const key = randomUUID();
        let cursor = 0;
        for await (const chunk of driver.exec(handle, ["sh", "-c", "printf 'before\\n'; sleep 1; printf 'after\\n'"], {
          sessionKey: key,
        })) {
          if (chunk.kind === "stdout") {
            assert.equal(chunk.data, "before\n");
            cursor = chunk.cursor ?? 0;
            break;
          }
        }
        assert.ok(cursor > 0);
        const replacement = new DockerDriver(docker, "none");
        const attached = await replacement.attach(handle, ["sh"], { sessionKey: key, afterCursor: cursor });
        assert.ok(attached);
        const resumed = await collectExec(attached);
        assert.equal(resumed.stdout, "after\n");
        assert.equal(resumed.exitCode, 0);
      });
      await t.test("the replacement server can write to the surviving agent stdin", async () => {
        const key = randomUUID();
        const originalInput = new LineChannel();
        originalInput.write("first");
        for await (const chunk of driver.exec(handle, ["sh", "-c", "read a; echo got:$a; read b; echo got:$b"], {
          sessionKey: key,
          stdin: originalInput,
        })) {
          if (chunk.kind === "stdout") {
            assert.equal(chunk.data, "got:first\n");
            break;
          }
        }
        const replacementInput = new LineChannel();
        replacementInput.write("second");
        replacementInput.end();
        const replacement = new DockerDriver(docker, "none");
        const attached = await replacement.attach(handle, ["sh"], { sessionKey: key, afterCursor: 1, stdin: replacementInput });
        assert.ok(attached);
        const resumed = await collectExec(attached);
        assert.equal(resumed.stdout, "got:second\n");
        assert.equal(resumed.exitCode, 0);
        originalInput.end();
      });
      await t.test("cancelling a durable run stops its process", async () => {
        const controller = new AbortController();
        const key = randomUUID();
        const chunks: string[] = [];
        for await (const chunk of driver.exec(handle, ["sh", "-c", "echo started:$$; sleep 300"], {
          sessionKey: key,
          signal: controller.signal,
        })) {
          if (chunk.kind === "stdout") {
            chunks.push(chunk.data);
            controller.abort();
          }
          if (chunk.kind === "exit") assert.equal(chunk.exitCode, -1);
        }
        const pid = /started:(\d+)/.exec(chunks.join(""))?.[1];
        assert.ok(pid);
        const status = await collectExec(driver.exec(handle, ["ps", "-eo", "pid,stat"]));
        const line = status.stdout.split("\n").find((entry) => entry.trim().split(/\s+/)[0] === pid);
        assert.ok(!line || line.trim().split(/\s+/)[1]!.startsWith("Z"), `process still running: ${line}`);
      });
      await t.test("a durable run whose container stopped answering still ends at its timeout", async () => {
        const container = docker.getContainer(handle.externalId);
        const chunks: ExecChunk[] = [];
        let paused = false;
        const started = Date.now();
        try {
          for await (const chunk of driver.exec(handle, ["sh", "-c", "echo started; sleep 300"], {
            sessionKey: randomUUID(),
            timeoutMs: 2000,
          })) {
            chunks.push(chunk);
            if (chunk.kind === "stdout" && !paused) {
              paused = true;
              await container.pause();
            }
          }
        } finally {
          if (paused) await container.unpause();
        }
        assert.ok(paused);
        assert.deepEqual(chunks.at(-1), { kind: "exit", exitCode: -1 });
        assert.ok(chunks.some((chunk) => chunk.kind === "stderr" && /exec timeout/.test(chunk.data)));
        assert.ok(Date.now() - started < 30_000, "the stop must not wait on a container that cannot answer");
      });
      await t.test("a durable run ends when its container is no longer running", async () => {
        let stopped = false;
        const lying = new Proxy(docker, {
          get(target, prop) {
            if (prop === "getContainer") {
              return (id: string) =>
                new Proxy(target.getContainer(id), {
                  get(container, key) {
                    if (key === "inspect" && stopped) return async () => ({ State: { Running: false } });
                    const value = Reflect.get(container, key, container) as unknown;
                    return typeof value === "function" ? value.bind(container) : value;
                  },
                });
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const watched = new DockerDriver(lying, "none", { livenessMs: 300 });
        const chunks: ExecChunk[] = [];
        for await (const chunk of watched.exec(handle, ["sh", "-c", "echo started; sleep 300"], { sessionKey: randomUUID() })) {
          chunks.push(chunk);
          if (chunk.kind === "stdout") stopped = true;
        }
        assert.deepEqual(chunks.at(-2), { kind: "stderr", data: SANDBOX_STOPPED_MESSAGE });
        assert.deepEqual(chunks.at(-1), { kind: "exit", exitCode: -1 });
        assert.equal(await watched.running({ ...handle, externalId: `missing-${randomUUID()}` }), false);
        assert.equal(await driver.running(handle), true);
      });
    } finally {
      await driver.destroy(handle);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
