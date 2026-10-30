import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { checkoutStepFailure, checkoutSteps, type CheckoutStep } from "./checkout-steps.js";

const exec = promisify(execFile);

/** Background maintenance off, as in start-bundle.test.ts, so the temp directory can be removed. */
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Bento",
  GIT_AUTHOR_EMAIL: "bento@example.com",
  GIT_COMMITTER_NAME: "Bento",
  GIT_COMMITTER_EMAIL: "bento@example.com",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
};

const removeRoot = (root: string) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: gitEnv });
  return stdout;
}

type Ran = { exitCode: number; stdout: string; stderr: string };

async function sh(script: string, cwd: string): Promise<Ran> {
  try {
    const { stdout, stderr } = await exec("sh", ["-c", script], { cwd, env: gitEnv });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** Runs the steps the way a driver does, one at a time, stopping at the first that fails. */
async function runSteps(steps: CheckoutStep[], cwd: string): Promise<{ ran: Ran[]; failed?: { step: CheckoutStep; ran: Ran } }> {
  const ran: Ran[] = [];
  for (const step of steps) {
    const result = await sh(step.script, cwd);
    ran.push(result);
    if (result.exitCode !== 0) return { ran, failed: { step, ran: result } };
  }
  return { ran };
}

async function originRepo(root: string): Promise<string> {
  const work = path.join(root, "work");
  await git(root, ["init", "-q", "-b", "main", work]);
  await writeFile(path.join(work, "README.md"), "hello\n");
  await git(work, ["add", "README.md"]);
  await git(work, ["commit", "-qm", "first"]);
  const origin = path.join(root, "origin.git");
  await git(root, ["clone", "-q", "--bare", work, origin]);
  return origin;
}

test("a clone onto a new branch succeeds, and no step leaves git's fallback words behind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-checkout-"));
  try {
    const origin = await originRepo(root);
    const dir = path.join(root, "checkout");
    const steps = checkoutSteps({ dir, cloneUrl: origin, branch: "bento/card-1", baseBranch: "main" });
    assert.deepEqual(steps.map((step) => step.source), ["remote", "branch"]);

    const first = await runSteps(steps, root);
    assert.equal(first.failed, undefined, first.failed?.ran.stderr);
    assert.equal((await git(dir, ["branch", "--show-current"])).trim(), "bento/card-1");
    for (const ran of first.ran) assert.doesNotMatch(ran.stderr, /pathspec/, "the fallback's first try says nothing");

    // Twice, because a driver runs a step again after a dropped connection.
    const again = await runSteps(steps, root);
    assert.equal(again.failed, undefined, again.failed?.ran.stderr);
  } finally {
    await removeRoot(root);
  }
});

test("a repository git cannot find is the project's, and a seeded checkout's failure is the machine's", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-checkout-"));
  try {
    const missing = checkoutSteps({
      dir: path.join(root, "checkout"),
      cloneUrl: path.join(root, "no-such-repo.git"),
      branch: "bento/card-1",
      baseBranch: "main",
    });
    const refused = await runSteps(missing, root);
    assert.ok(refused.failed, "the clone should fail");
    assert.equal(refused.failed.step.source, "remote");
    const failure = checkoutStepFailure("modal", refused.failed.step, Object.assign(new Error("clone failed"), refused.failed.ran));
    assert.equal(failure.phase, "checkout");
    assert.equal(failure.blame, "project");

    const seeded = checkoutSteps({
      dir: path.join(root, "seeded"),
      cloneUrl: "https://github.com/acme/app.git",
      branch: "bento/card-1",
      baseBranch: "main",
      seed: { bundlePath: path.join(root, "missing.bundle") },
    });
    const broken = await runSteps(seeded, root);
    assert.ok(broken.failed, "a clone from a bundle that is not there should fail");
    assert.equal(broken.failed.step.source, "local");
    assert.match(broken.failed.ran.stderr, /fatal:/, "git says why, and it still is not the project's");
    const machine = checkoutStepFailure("sprite", broken.failed.step, Object.assign(new Error("clone failed"), broken.failed.ran));
    assert.equal(machine.blame, "provider");
  } finally {
    await removeRoot(root);
  }
});

test("a step that did not exit is the machine's, whatever came before it", () => {
  const [remote] = checkoutSteps({ dir: "/workspace/app", cloneUrl: "https://github.com/acme/app.git", branch: "b", baseBranch: "main" });
  assert.ok(remote);
  const dropped = Object.assign(new Error("the connection closed"), { stderr: "fatal: early EOF" });
  assert.equal(checkoutStepFailure("sprite", remote, dropped).blame, "provider", "no exit code, so not git's refusal");
  const killed = Object.assign(new Error("exit 137"), { exitCode: 137, stderr: "" });
  assert.equal(checkoutStepFailure("modal", remote, killed).blame, "provider", "git did not say why");
});

/**
 * A card whose machine was released after it sat idle is made again on
 * the branch Bento pushed for it. The seed is the base branch, as for
 * every hosted card; the start bundle is the card's own branch read
 * back from GitHub (`branch ^base`), and the run's branch is that same
 * branch, so the new checkout must land on its saved head, not on a
 * fresh branch cut from the base.
 */
test("a card's saved branch comes back as the run's own branch on a new seeded machine", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-checkout-restore-"));
  try {
    const origin = await originRepo(root);
    const seed = path.join(root, "seed.bundle");
    await git(origin, ["bundle", "create", seed, "refs/heads/main"]);

    const card = path.join(root, "card");
    await git(root, ["clone", "-q", origin, card]);
    await git(card, ["checkout", "-q", "-b", "bento/idle-card"]);
    await writeFile(path.join(card, "feature.ts"), "export const saved = true;\n");
    await git(card, ["add", "."]);
    await git(card, ["commit", "-q", "-m", "the card's work"]);
    const saved = (await git(card, ["rev-parse", "HEAD"])).trim();
    const base = (await git(card, ["merge-base", "HEAD", "origin/main"])).trim();
    const start = path.join(root, "start.bundle");
    await git(card, ["bundle", "create", start, "refs/heads/bento/idle-card", `^${base}`]);

    const dir = path.join(root, "machine", "app");
    const { failed } = await runSteps(
      checkoutSteps({
        dir,
        branch: "bento/idle-card",
        baseBranch: "main",
        seed: { bundlePath: seed, start: { bundlePath: start, branch: "bento/idle-card" } },
      }),
      root,
    );
    assert.equal(failed, undefined, failed?.ran.stderr);
    assert.equal((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "bento/idle-card");
    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), saved, "the checkout is the saved head");
  } finally {
    await removeRoot(root);
  }
});
