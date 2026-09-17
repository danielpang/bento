import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProvisionSpec, SandboxDriver } from "@bento/sandbox";
import { LocalRunner } from "./runner.js";

test("a remote runner mounts its own CLI login only when sharing is enabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bento-runner-auth-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await mkdir(path.join(home, ".codex"));
    await writeFile(path.join(home, ".codex", "auth.json"), '{"token":"test"}');

    const run = async (shareAgentAuth: boolean) => {
      let provisioned: ProvisionSpec | undefined;
      const runner = new LocalRunner({
        baseUrl: "http://example.test",
        runnerId: "test",
        sandbox: "docker",
        dataDir: home,
        shareAgentAuth,
        onStatus: () => {},
      });
      const instance = runner as unknown as {
        driver: SandboxDriver;
        worktrees: { ensureAll: () => Promise<void>; workspacePath: () => string };
        complete: () => Promise<void>;
        execute: (claimed: unknown) => Promise<void>;
      };
      instance.driver = {
        provider: "docker",
        provision: async (spec: ProvisionSpec) => {
          provisioned = spec;
          return { externalId: "test", provider: "docker", workdir: "/workspace" };
        },
        exec: async function* () {
          yield { kind: "exit", exitCode: 0 } as const;
        },
      } as unknown as SandboxDriver;
      instance.worktrees = { ensureAll: async () => {}, workspacePath: () => home };
      instance.complete = async () => {};
      await instance.execute({
        run: { id: "run", featureId: "feature", stageId: "stage", prompt: "", resumeSessionId: null },
        feature: { id: "feature", title: "Test", branchName: "test" },
        agent: { cli: "codex", model: "gpt-5", extraArgs: [] },
        repositories: [{ name: "repo", localPath: home, defaultBranch: "main" }],
        stagePrompt: "Test",
      });
      assert.ok(provisioned, "the runner provisioned a sandbox");
      return provisioned.mounts ?? [];
    };

    const withoutSharing = await run(false);
    const withSharing = await run(true);
    assert.equal(withoutSharing.some((mount) => mount.containerPath === "/root/.codex"), false);
    assert.deepEqual(
      withSharing.find((mount) => mount.containerPath === "/root/.codex"),
      { hostPath: path.join(home, ".codex"), containerPath: "/root/.codex", readOnly: true },
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
