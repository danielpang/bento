import assert from "node:assert/strict";
import test from "node:test";
import { collectExec, type SandboxHandle } from "./driver.js";
import { ModalDriver } from "./modal.js";
import { sandboxFileExists, writeSandboxFiles } from "./sandbox-files.js";

/**
 * A real Modal sandbox: toolchain image, one agent CLI, a follow stream
 * dropped and read again from byte 0, then hibernate and restore.
 *
 * Not part of `pnpm test`. It costs a machine and needs Modal tokens.
 * Turned on by BENTO_MODAL_E2E=1 and both token vars. A token sitting
 * in the environment for some other reason must not create machines
 * during an ordinary test run. See .github/workflows/modal-e2e.yml.
 *
 * The secret's product name is MODAL_TOKEN_SECRET. A local shell that
 * only has MODAL_SECRET_TOKEN can still run this file. That fallback
 * stays here, not in the driver.
 */
const tokenId = process.env.MODAL_TOKEN_ID;
const tokenSecret = process.env.MODAL_TOKEN_SECRET || process.env.MODAL_SECRET_TOKEN;
const skip = !process.env.BENTO_MODAL_E2E
  ? "set BENTO_MODAL_E2E=1 to provision a real Modal sandbox"
  : !tokenId || !tokenSecret
    ? "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set"
    : false;

const runTag = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : `local-${Date.now()}`;
const featureId = `e2e-${runTag}`;

test(
  "a Modal sandbox runs a CLI, reattaches, hibernates, and restores",
  { skip, timeout: 25 * 60_000 },
  async () => {
    const driver = new ModalDriver({
      tokenId: tokenId!,
      tokenSecret: tokenSecret!,
      ...(process.env.MODAL_ENVIRONMENT ? { environment: process.env.MODAL_ENVIRONMENT } : {}),
    });
    let handle: SandboxHandle | null = null;
    try {
      handle = await driver.provision({
        projectId: "e2e",
        workspaceKey: featureId,
        hostWorkspacePath: "/tmp/unused",
        agentBinaries: ["claude"],
        onProgress: (line) => {
          console.log(line);
        },
      });
      const version = await collectExec(driver.exec(handle, ["claude", "--version"], { timeoutMs: 60_000 }));
      assert.equal(version.exitCode, 0, version.stderr);
      assert.ok(version.stdout.trim().length > 0);

      // What a swarm run does before its agent starts: copy the plan
      // sources in through stdin. The swarm that hung handed over about
      // 50KB of plan, 67KB as base64, past the 64KB a pipe holds. Each
      // step has a deadline, so a regression fails here instead of
      // hanging the job.
      const plan = Buffer.alloc(50 * 1024, "plan line\n");
      const written = await within(
        3 * 60_000,
        "writing the plan sources",
        writeSandboxFiles(
          driver,
          handle,
          "/workspace/.bento/plan",
          [
            { name: "1-index.html", data: plan.toString("base64") },
            { name: "2-hub.js", data: Buffer.from("console.log(1)\n").toString("base64") },
          ],
          { overwrite: true, timeoutMs: 120_000 },
        ),
      );
      assert.deepEqual(written, ["/workspace/.bento/plan/1-index.html", "/workspace/.bento/plan/2-hub.js"]);
      const sizes = await collectExec(driver.exec(handle, ["wc", "-c", ...written], { timeoutMs: 30_000 }));
      assert.match(sizes.stdout, new RegExp(`${plan.length} /workspace/.bento/plan/1-index.html`));
      assert.equal(await sandboxFileExists(driver, handle, written[1]!), true);

      // The shape of the hang itself: stdin fed to a command that is not
      // there. Nothing reads the pipe, and the feeder must give up when
      // the command's exit is written rather than wait for the input to
      // drain.
      const missing = await within(
        3 * 60_000,
        "feeding stdin to a missing command",
        collectExec(
          driver.exec(handle, ["bento-no-such-command"], {
            timeoutMs: 60_000,
            stdin: (async function* () {
              yield "x".repeat(70 * 1024);
            })(),
          }),
        ),
      );
      assert.notEqual(missing.exitCode, 0);

      let release: (() => void) | undefined;
      const seen = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = driver.exec(handle, ["sh", "-c", "echo alpha; sleep 20; echo beta"]);
      const reader = first[Symbol.asyncIterator]();
      let text = "";
      for (;;) {
        const next = await reader.next();
        if (next.done) break;
        if (next.value.kind === "stdout") text += next.value.data;
        if (text.includes("alpha")) {
          release?.();
          break;
        }
      }
      await seen;
      await reader.return?.(undefined);
      const again = await driver.attach(handle, ["sh", "-c", "echo alpha; sleep 20; echo beta"]);
      assert.ok(again);
      const rest = await collectExec(again);
      assert.match(`${text}${rest.stdout}`, /alpha/);
      assert.match(rest.stdout, /beta/);
      assert.equal(rest.exitCode, 0);

      await collectExec(driver.exec(handle, ["sh", "-c", "echo kept > /workspace/marker"], { timeoutMs: 30_000 }));
      const saved = await driver.hibernate(handle);
      assert.ok(saved.imageId);
      handle = await driver.provision({
        projectId: "e2e",
        workspaceKey: featureId,
        hostWorkspacePath: "/tmp/unused",
        imageRef: saved.imageId,
        agentBinaries: ["claude"],
      });
      const marker = await collectExec(driver.exec(handle, ["cat", "/workspace/marker"], { timeoutMs: 30_000 }));
      assert.match(marker.stdout, /kept/);
    } finally {
      if (handle) {
        await driver.destroy(handle);
        const still = await driver.exists(handle);
        assert.equal(still, false);
      }
    }
  },
);

/** Fails with `label` when `promise` has not settled after `ms`, instead of hanging the job. */
async function within<T>(ms: number, label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
