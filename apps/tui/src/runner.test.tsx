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

test("a remote runner reports duplicate checkouts before provisioning Docker", async () => {
  let provisioned = false;
  let reported = "";
  const runner = new LocalRunner({
    baseUrl: "http://example.test",
    runnerId: "test",
    sandbox: "docker",
    dataDir: tmpdir(),
    onStatus: () => {},
  });
  const instance = runner as unknown as {
    driver: SandboxDriver;
    worktrees: { ensureAll: () => Promise<void> };
    complete: (_id: string, outcome: { error?: string }) => Promise<void>;
    execute: (claimed: unknown) => Promise<void>;
  };
  instance.driver = {
    provider: "docker",
    provision: async () => {
      provisioned = true;
      throw new Error("Docker should not be called");
    },
  } as unknown as SandboxDriver;
  instance.worktrees = { ensureAll: async () => { throw new Error("worktrees should not be changed"); } };
  instance.complete = async (_id, outcome) => { reported = outcome.error ?? ""; };

  await instance.execute({
    run: { id: "run", featureId: "feature", stageId: "stage", prompt: "", resumeSessionId: null },
    feature: { id: "feature", title: "Test", branchName: "test" },
    agent: { cli: "codex", model: "gpt-5", extraArgs: [] },
    repositories: [
      { name: "bento", localPath: "/Users/me/projects/bento", defaultBranch: "main" },
      { name: "bento-2", localPath: "/Users/me/projects/bento/", defaultBranch: "main" },
    ],
    stagePrompt: "Test",
  });
  assert.equal(provisioned, false);
  assert.match(reported, /Repositories bento and bento-2 use the same checkout/);
  assert.match(reported, /Settings, Repositories/);
});

test("a remote runner rejects a removed custom provider before provisioning", async () => {
  let provisioned = false;
  let reported = "";
  const runner = new LocalRunner({
    baseUrl: "http://example.test",
    runnerId: "test",
    sandbox: "docker",
    dataDir: tmpdir(),
    onStatus: () => {},
  });
  const instance = runner as unknown as {
    driver: SandboxDriver;
    complete: (_id: string, outcome: { error?: string }) => Promise<void>;
    execute: (claimed: unknown) => Promise<void>;
  };
  instance.driver = {
    provider: "docker",
    provision: async () => { provisioned = true; throw new Error("Docker should not be called"); },
  } as unknown as SandboxDriver;
  instance.complete = async (_id, outcome) => { reported = outcome.error ?? ""; };

  await instance.execute({
    run: { id: "run", featureId: "feature", stageId: "stage", prompt: "", resumeSessionId: null },
    feature: { id: "feature", title: "Test", branchName: "test" },
    agent: { cli: "codex", model: "retired-models/reasoning-a", extraArgs: [] },
    customProvider: { env: {}, missingKey: false, disabled: true },
    repositories: [{ name: "repo", localPath: "/tmp/repo", defaultBranch: "main" }],
    stagePrompt: "Test",
  });
  assert.equal(provisioned, false);
  assert.match(reported, /custom provider is not available/);
});
