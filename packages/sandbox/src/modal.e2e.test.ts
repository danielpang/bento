import assert from "node:assert/strict";
import test from "node:test";
import { collectExec, type SandboxHandle } from "./driver.js";
import { ModalDriver } from "./modal.js";

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

      // A command that reads stdin to its end, the shape every file
      // written through writeSandboxFiles takes. EOF has to arrive after
      // the bytes, at their offset: sent at offset 0 it was dropped, and
      // the command waited for input until the timeout killed it.
      const fed = await collectExec(
        driver.exec(handle, ["sh", "-c", "cat; echo done"], {
          timeoutMs: 60_000,
          stdin: (async function* () {
            yield "from-stdin";
          })(),
        }),
      );
      assert.equal(fed.exitCode, 0, fed.stderr);
      assert.equal(fed.stdout, "from-stdin\ndone\n");

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
