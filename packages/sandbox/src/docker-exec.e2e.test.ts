import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DockerDriver } from "./docker.js";
import { createDockerClient } from "./docker-client.js";
import { collectExec, LineChannel } from "./driver.js";

// Uses only the installed sandbox image, no agent credentials or network.
test(
  "Docker stops timed-out and cancelled execs without stopping unrelated commands",
  {
    skip: process.env.BENTO_DOCKER_E2E !== "1",
    timeout: 60000,
  },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "bento-exec-test-"));
    const docker = createDockerClient();
    const driver = new DockerDriver(docker, "none");
    const handle = await driver.provision({
      projectId: "exec-test",
      featureId: `exec-test-${randomUUID()}`,
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
    } finally {
      await driver.destroy(handle);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
