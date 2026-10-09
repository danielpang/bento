import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fetchStartBundleCommand } from "./start-bundle.js";

const exec = promisify(execFile);

/**
 * Background maintenance off, for every git this test runs, including
 * the ones inside the checkout script. A recent git may start
 * `maintenance run --auto` detached after a fetch, and it was still
 * writing into objects/pack when the test removed its temp directory
 * (ENOTEMPTY on CI's git 2.55, never on 2.43). The sprite does not
 * care what git does after the script ends; this directory does.
 */
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

/** The same backstop for a git that ignores the config: retry a directory something is still writing. */
const removeRoot = (root: string) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: gitEnv });
  return stdout;
}

async function sh(script: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("sh", ["-c", script], { cwd, env: gitEnv });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/**
 * The checkout a sprite actually runs, minus the remote rewrite.
 * The seed is the base branch. The start bundle is the swarm's head.
 */
function prepareScript(dir: string, seed: string, start: string, swarmBranch: string, workerBranch: string): string {
  return [
    "set -eu",
    `if [ -d ${shellQuote(dir)}/.git ]; then`,
    `  cd ${shellQuote(dir)} && git fetch ${shellQuote(seed)} refs/heads/main:refs/remotes/origin/main`,
    "else",
    `  git clone ${shellQuote(seed)} ${shellQuote(dir)}`,
    "fi",
    fetchStartBundleCommand(dir, start, swarmBranch),
    `cd ${shellQuote(dir)} && (git checkout ${shellQuote(workerBranch)} || git checkout -b ${shellQuote(workerBranch)} ${shellQuote(swarmBranch)})`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * What production exports, and the fetch provisioning used to run.
 *
 * exportRepository writes `git bundle create HEAD ^base`. That bundle
 * lists HEAD and nothing else. The checkout asked for
 * refs/heads/<swarm branch>, which is the exit 128 in the server log:
 * "fatal: couldn't find remote ref refs/heads/swarm/agent-queue-re-write".
 */
test("a HEAD start bundle has no branch ref, which is the exit 128", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-start-ref-"));
  try {
    const origin = path.join(root, "origin");
    await git(root, ["init", "--quiet", "-b", "main", origin]);
    await writeFile(path.join(origin, "totals.ts"), "export const total = 0;\n");
    await git(origin, ["add", "."]);
    await git(origin, ["commit", "--quiet", "-m", "base"]);
    const base = (await git(origin, ["rev-parse", "HEAD"])).trim();
    await git(origin, ["checkout", "--quiet", "-b", "swarm/checkout"]);
    await writeFile(path.join(origin, "totals.ts"), "export const total = 1;\n");
    await git(origin, ["commit", "--quiet", "-am", "landed"]);

    const seed = path.join(root, "seed.bundle");
    const start = path.join(root, "start.bundle");
    await git(origin, ["bundle", "create", seed, "refs/heads/main"]);
    await git(origin, ["bundle", "create", start, "HEAD", `^${base}`]);
    const heads = await git(root, ["bundle", "list-heads", start]);
    assert.match(heads, /\bHEAD$/m);
    assert.doesNotMatch(heads, /refs\/heads\/swarm\/checkout/);

    const work = path.join(root, "work");
    await git(root, ["clone", "--quiet", seed, work]);
    const refused = await sh(
      `cd ${shellQuote(work)} && git fetch ${shellQuote(start)} +refs/heads/swarm/checkout:refs/heads/swarm/checkout`,
      root,
    );
    assert.equal(refused.code, 128);
    assert.match(refused.stderr, /couldn't find remote ref refs\/heads\/swarm\/checkout/);
  } finally {
    await removeRoot(root);
  }
});

/**
 * The same bundles, fetched the way provisioning does now.
 *
 * The first attempt in production cloned the seed and then died on
 * the fetch, so the retry found a checkout. Both shapes have to land
 * on the swarm's commit, and a second run must not trip over the
 * checkout the first one left.
 */
test("a worker checkout takes a HEAD bundle or a branch bundle, including on retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bento-start-ok-"));
  try {
    const origin = path.join(root, "origin");
    await git(root, ["init", "--quiet", "-b", "main", origin]);
    await writeFile(path.join(origin, "totals.ts"), "export const total = 0;\n");
    await git(origin, ["add", "."]);
    await git(origin, ["commit", "--quiet", "-m", "base"]);
    const base = (await git(origin, ["rev-parse", "HEAD"])).trim();
    await git(origin, ["checkout", "--quiet", "-b", "swarm/checkout"]);
    await writeFile(path.join(origin, "totals.ts"), "export const total = 1;\n");
    await git(origin, ["commit", "--quiet", "-am", "landed"]);
    const swarm = (await git(origin, ["rev-parse", "HEAD"])).trim();

    const seed = path.join(root, "seed.bundle");
    await git(origin, ["bundle", "create", seed, "refs/heads/main"]);

    const headBundle = path.join(root, "head.bundle");
    await git(origin, ["bundle", "create", headBundle, "HEAD", `^${base}`]);
    const rangeBundle = path.join(root, "range.bundle");
    await git(origin, ["bundle", "create", rangeBundle, `${base}..swarm/checkout`]);

    const worker = "swarm/checkout-aaaaaaaa";
    for (const start of [headBundle, rangeBundle]) {
      const fresh = path.join(root, `fresh-${path.basename(start)}`);
      const first = await sh(prepareScript(fresh, seed, start, "swarm/checkout", worker), root);
      assert.equal(first.code, 0, first.stderr);
      assert.equal((await git(fresh, ["rev-parse", "HEAD"])).trim(), swarm);
      assert.equal((await git(fresh, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), worker);

      // A second provision of the same machine: the checkout is already
      // there, including the swarm ref at the current head.
      const again = await sh(prepareScript(fresh, seed, start, "swarm/checkout", worker), root);
      assert.equal(again.code, 0, again.stderr);
      assert.equal((await git(fresh, ["rev-parse", "HEAD"])).trim(), swarm);

      // What the failed first attempt left behind: the seed, cloned,
      // and no swarm ref. The retry runs the same script.
      const retried = path.join(root, `retry-${path.basename(start)}`);
      await git(root, ["clone", "--quiet", seed, retried]);
      const retry = await sh(prepareScript(retried, seed, start, "swarm/checkout", worker), root);
      assert.equal(retry.code, 0, retry.stderr);
      assert.equal((await git(retried, ["rev-parse", "HEAD"])).trim(), swarm);
    }
  } finally {
    await removeRoot(root);
  }
});
