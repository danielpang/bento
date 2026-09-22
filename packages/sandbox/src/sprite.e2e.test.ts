import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SpritesClient } from "@fly/sprites";
import { writeFileCommand } from "@bento/agents";
import { AGENT_BINARIES, TOOLCHAIN_LEGACY_MARKER, TOOLCHAIN_STAMPS } from "./agent-toolchain.js";
import { collectExec, type SandboxHandle } from "./driver.js";
import { taskRequest } from "./keep-awake.js";
import { SpriteDriver, spriteExistsWithRetry, spriteName } from "./sprite.js";

/**
 * The one test that provisions a real Fly Sprite and installs the real
 * agent CLIs into it.
 *
 * Everything else about the toolchain is checked against stubs, which
 * is fast and deterministic and cannot see the failures that actually
 * happen: an installer that moves its binary somewhere `publish` does
 * not look, a CDN that starts answering 403, opencode's release moving
 * to another GitHub organization, a CLI that installs but will not run
 * because the sprite's libc is older than the binary wants. Every one
 * of those is invisible to a stub and obvious here.
 *
 * It is not part of `pnpm test`. It costs a real machine and several
 * minutes, and it needs a Sprites token, so it runs on a schedule and
 * whenever the toolchain script changes, which includes every bump of
 * TOOLCHAIN_VERSION. See .github/workflows/sandbox-e2e.yml.
 *
 * Turned on by BENTO_SPRITE_E2E=1 and a SPRITES_TOKEN. Both, on
 * purpose: a token in the environment for some other reason must not
 * silently start creating machines during an ordinary test run.
 */
const token = process.env.SPRITES_TOKEN;
const skip = !process.env.BENTO_SPRITE_E2E
  ? "set BENTO_SPRITE_E2E=1 to provision a real sprite"
  : !token
    ? "SPRITES_TOKEN is not set"
    : false;

/**
 * A name nobody else is using, and one the workflow can work out for
 * itself. Sprites are one per feature and live until deleted, so a
 * fixed name would have two runs fighting over one machine and the
 * loser reporting failures that are really the other run's cleanup.
 *
 * Derived from the run rather than the process, because a job that is
 * cancelled or times out kills this process before it can tidy up, and
 * the only thing left that can delete the machine is a workflow step
 * that has to name it without asking us. See sandbox-e2e.yml.
 */
const runTag = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : `local-${Date.now()}`;
const workspaceKey = `e2e-${runTag}`;

/**
 * git on the runner, for building the bundles a swarm's worker is
 * seeded from. Nothing here runs inside the sandbox: what is being
 * checked is that what this side produces is what the other side can
 * use.
 */
const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@localhost",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

/** Long: a cold sprite installs ten CLIs and a private Node. */
const PROVISION_TIMEOUT_MS = 25 * 60_000;
const exec = promisify(execFile);

const DSH_MOCK_SERVER = `import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const hasToolResult = body.messages.some((message) => message.role === "tool");
  appendFileSync("/tmp/bento-dsh-requests", JSON.stringify({
    authorization: request.headers.authorization,
    model: body.model,
    hasTools: Array.isArray(body.tools),
    hasToolResult,
  }) + "\\n");
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  if (Array.isArray(body.tools) && !hasToolResult) {
    response.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo verified > /workspace/dsh-e2e-marker", description: "verify local tools" }) } }] }, finish_reason: null }] }) + "\\n\\n");
    response.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "\\n\\n");
  } else {
    const content = Array.isArray(body.tools) ? "sprite dsh complete" : "title";
    response.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + "\\n\\n");
    response.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\\n\\n");
  }
  response.end("data: [DONE]\\n\\n");
}).listen(43123, "127.0.0.1", () => writeFileSync("/tmp/bento-dsh-ready", "ready"));
`;

test("a real sprite ends up with every agent CLI, and heals when one goes missing", { skip }, async (t) => {
  const driver = new SpriteDriver({ token: token!, timeoutMs: PROVISION_TIMEOUT_MS });
  const handle: SandboxHandle = {
    externalId: spriteName(workspaceKey),
    provider: "sprite",
    workdir: "/workspace",
  };
  /**
   * The driver answers "did it work" for everything except deletion:
   * destroy swallows whatever deleteSprite says, so a machine that
   * survived looks exactly like one that did not. The only honest way
   * to know is to ask the API afterwards, so this test keeps a client
   * of its own for that one question. spriteExists throws rather than
   * guessing when the API cannot answer, which is what stops an
   * unreachable API reading as a tidy machine.
   *
   * The lookup is retried when that request is aborted. A cold run's
   * first getSprite hung until this client's minute-long timeout, and
   * the suite ended before a machine existed. A missing sprite still
   * answers 404. A lookup that keeps failing still throws.
   */
  const client = new SpritesClient(token!, { timeout: 60_000 });
  const exists = () =>
    spriteExistsWithRetry(client, handle.externalId, (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.log(`  sprite lookup failed (${detail}). Retrying.`);
    });

  /**
   * The net under the asserted teardown below, for the paths that never
   * reach it: the test body throwing outside a subtest, or a bail.
   * Deliberately quiet, because when teardown did run this is a second
   * delete of something already gone.
   */
  let deleted = false;
  t.after(async () => {
    if (deleted) return;
    await driver.destroy(handle);
    // Not asserted: this path is reached when something else already
    // went wrong, and a second failure would bury the first. The
    // workflow deletes by name afterwards whatever happens here.
    const survived = await exists().catch(() => true);
    if (survived) {
      console.error(`the test sprite ${handle.externalId} outlived the test and may still be billed`);
    }
  });

  const said: string[] = [];
  const provision = (agentBinaries?: readonly string[]) =>
    driver.provision({
      projectId: "sprite-e2e",
      workspaceKey,
      hostWorkspacePath: "/unused",
      ...(agentBinaries ? { agentBinaries } : {}),
      onProgress: (message) => {
        said.push(message);
        console.log(`  ${message}`);
      },
    });

  /** What the sprite itself says, which is the only answer that counts. */
  const shell = async (script: string) => {
    const result = await collectExec(driver.exec(handle, ["sh", "-c", script], { timeoutMs: 120_000 }));
    return { ...result, out: result.stdout.trim() };
  };
  const present = async () => {
    const script = AGENT_BINARIES.map((binary) => `command -v ${binary} >/dev/null 2>&1 && echo ${binary}`).join(
      "\n",
    );
    const { out } = await shell(script);
    return out.split("\n").filter(Boolean).sort();
  };

  const expected = [...AGENT_BINARIES].sort();

  /**
   * Removes a CLI from wherever it actually is, rather than from
   * wherever it was expected to be.
   *
   * The first version listed the directories the installers use and
    * deleted from those. It missed three of the original five: the sprite's HOME
   * is not /root, so the binaries publish() links from sit somewhere
   * the list never named, and that directory is on the PATH in its own
   * right, so deleting the symlink in /usr/local/bin left the CLI
   * working and the test asserting against a machine it had not
   * changed. Asking the PATH where something is cannot miss it.
   *
   * Bounded rather than looping until gone: a path that cannot be
   * removed should end the loop, not spin in it.
   */
  const uninstall = (binaries: readonly string[]) =>
    shell(
      binaries
        .map(
          (binary) =>
            `for attempt in 1 2 3 4 5; do\n` +
            `  p=$(command -v ${binary} 2>/dev/null) || break\n` +
            `  rm -f "$p" || break\n` +
            `done`,
        )
        .join("\n"),
    );

  /**
   * Everything below the first check needs a machine to talk to, so a
   * sprite that never came up would otherwise report the same failure
   * five times over and bury the one that happened. This runs
   * unattended overnight; the report has to be readable in the morning.
   */
  let up = false;
  const needsSprite = () => (up ? false : "the sprite never came up");

  await t.test("a cold provision creates the machine and installs the whole set", async () => {
    assert.equal(await exists(), false, "a sprite with this run's name already existed");
    const cold = await provision();
    assert.equal(cold.externalId, handle.externalId);
    assert.equal(await exists(), true, "provisioning returned a handle for a sprite that is not there");
    assert.ok(
      said.some((message) => message.includes("Installing the agent tools")),
      "a brand new sprite should have said it was installing",
    );
    // The failure this whole file exists for: provisioning must not
    // report a CLI it could not install.
    const failed = said.filter((message) => message.includes("Could not install"));
    assert.deepEqual(failed, [], `provisioning could not install every CLI: ${failed.join(" ")}`);
    assert.deepEqual(await present(), expected);
    up = true;
  });

  await t.test("a real sprite accepts a credential-free landing bundle with a head lease", { skip: needsSprite() }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bento-sprite-landing-"));
    try {
      const repo = path.join(root, "repo");
      const seedPath = path.join(root, "seed.bundle");
      await exec("git", ["init", "--quiet", "-b", "main", repo]);
      await writeFile(path.join(repo, "base.txt"), "base\n");
      const identity = {
        ...process.env,
        GIT_AUTHOR_NAME: "Bento test",
        GIT_AUTHOR_EMAIL: "bento@localhost",
        GIT_COMMITTER_NAME: "Bento test",
        GIT_COMMITTER_EMAIL: "bento@localhost",
      };
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "--quiet", "-m", "base"], { env: identity });
      await exec("git", ["-C", repo, "bundle", "create", seedPath, "main"]);

      await driver.provision({
        projectId: "sprite-e2e",
        workspaceKey,
        hostWorkspacePath: "/unused",
        agentBinaries: [],
        repositories: [
          {
            name: "landing-e2e",
            cloneUrl: "https://example.invalid/landing-e2e.git",
            baseBranch: "main",
            branch: "swarm/e2e",
            seedBundle: await readFile(seedPath),
          },
        ],
      });

      const made = await shell(
        [
          "cd /workspace/landing-e2e",
          "before=$(git rev-parse HEAD)",
          "git config user.name 'Bento test'",
          "git config user.email 'bento@localhost'",
          "printf 'landed\\n' > landed.txt",
          "git add landed.txt",
          "git commit --quiet -m landed",
          "printf '%s\\n%s\\n' \"$before\" \"$(git rev-parse HEAD)\"",
        ].join(" && "),
      );
      assert.equal(made.exitCode, 0, made.stderr);
      const [before, landedHead] = made.out.split("\n");
      assert.ok(before && landedHead);

      const bundle = await driver.exportRepository(handle, "landing-e2e", "main", { selfContained: true });
      assert.ok(bundle);
      assert.equal(bundle.headSha, landedHead);
      assert.equal((await shell(`git -C /workspace/landing-e2e reset --hard ${before}`)).exitCode, 0);

      const imported = await driver.importRepository(handle, "landing-e2e", bundle, {
        branch: "swarm/e2e",
        expectedHeadSha: before,
      });
      assert.deepEqual(imported, { ok: true, headSha: landedHead });
      const verified = await shell("git -C /workspace/landing-e2e status --porcelain && cat /workspace/landing-e2e/landed.txt");
      assert.equal(verified.exitCode, 0, verified.stderr);
      assert.equal(verified.out, "landed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * `command -v` was the whole check in the image, and it cannot tell a
   * working binary from one that will not start. A CLI built against a
   * newer libc than the sprite carries passes it and then fails every
   * run with an exec error.
   */
  await t.test("every installed CLI actually runs", { skip: needsSprite() }, async () => {
    const broken: string[] = [];
    for (const binary of AGENT_BINARIES) {
      const { exitCode, stdout, stderr } = await shell(`${binary} --version`);
      if (exitCode !== 0) broken.push(`${binary} (exit ${exitCode}: ${(stderr || stdout).trim().slice(0, 200)})`);
    }
    assert.deepEqual(broken, [], `installed but not runnable: ${broken.join(", ")}`);
  });

  // Configs written under /root were never read: the sprite's HOME is elsewhere.
  await t.test("a home-relative config file lands in the agent's own home", { skip: needsSprite() }, async () => {
    const [, , script] = writeFileCommand({ path: "~/.bento-e2e/probe.json", content: '{"ok":true}' });
    const written = await shell(script!);
    assert.equal(written.exitCode, 0, `could not write the probe: ${written.stderr}`);
    const read = await shell('cat "$HOME/.bento-e2e/probe.json"; rm -rf "$HOME/.bento-e2e"');
    assert.equal(read.exitCode, 0, `the probe is not in $HOME: ${read.stderr}`);
    assert.deepEqual(JSON.parse(read.out), { ok: true });
    // Write and read share one exec; HOME must also be the account's home.
    const home = await shell('printf %s "$HOME"; echo; getent passwd "$(id -un)" | cut -d: -f6');
    const [seen, account] = home.out.split("\n").map((line) => line.trim());
    assert.equal(seen, account, "the exec's HOME must be the account's home, or a harness spawned from a login shell reads elsewhere");
    assert.notEqual(seen, "/root", "a sprite's home is its own user's, which is the whole point of the check");
  });

  /**
   * agy signs in with a Google account unless settings.json redirects
   * it to the Gemini API, and it refuses to start when the setting and
   * the key disagree. The file is written by the same script that
   * installs the CLI, so a real provision is the only thing that can
   * say it landed where agy looks for it.
   */
  await t.test("agy is provisioned to run on a Gemini API key", { skip: needsSprite() }, async () => {
    const settings = await shell("cat \"$HOME/.gemini/antigravity-cli/settings.json\"");
    assert.equal(settings.exitCode, 0, `agy has no settings file: ${settings.stderr}`);
    assert.deepEqual(JSON.parse(settings.out), { modelProvider: "gemini" });
  });

  await t.test("dsh runs Bento's exact headless profile with local tools", { skip: needsSprite() }, async () => {
    const encoded = Buffer.from(DSH_MOCK_SERVER).toString("base64");
    const staged = await shell(
      [
        "rm -f /tmp/bento-dsh-ready /tmp/bento-dsh-requests /workspace/dsh-e2e-marker",
        `printf '%s' '${encoded}' | base64 -d > /tmp/bento-dsh-mock.mjs`,
      ].join(" && "),
    );
    assert.equal(staged.exitCode, 0, staged.stderr);

    const ran = await shell(
      [
        "/opt/bento/node/bin/node /tmp/bento-dsh-mock.mjs >/tmp/bento-dsh-mock.log 2>&1 & mock=$!",
        "trap 'kill $mock 2>/dev/null || true' EXIT",
        "for attempt in 1 2 3 4 5; do [ -f /tmp/bento-dsh-ready ] && break; sleep 1; done",
        "test -f /tmp/bento-dsh-ready",
        "DSH_MODEL=deepseek-v4-pro DSH_TOOLS_MODE=native DSH_PERMISSION_MODE=danger-full-access DSH_TELEMETRY_DISABLED=1 DEEPSEEK_API_KEY=mock-key DEEPSEEK_BASE_URL=http://127.0.0.1:43123/v1 dsh --profile headless 'verify Bento integration'",
      ].join("; "),
    );
    assert.equal(ran.exitCode, 0, ran.stderr || ran.stdout);
    assert.equal(ran.out, "sprite dsh complete");

    const marker = await shell("cat /workspace/dsh-e2e-marker");
    assert.equal(marker.exitCode, 0, marker.stderr);
    assert.equal(marker.out, "verified", "dsh did not execute its local bash tool");
    const requests = await shell("cat /tmp/bento-dsh-requests");
    assert.equal(requests.exitCode, 0, requests.stderr);
    assert.match(requests.out, /\"authorization\":\"Bearer mock-key\"/);
    assert.match(requests.out, /\"model\":\"deepseek-v4-pro\"/);
    assert.match(requests.out, /\"hasToolResult\":true/);
    await shell("rm -f /workspace/dsh-e2e-marker /tmp/bento-dsh-*");
  });

  /**
   * fx is in AGENT_BINARIES, so install and --version are covered.
   * `--json` and `--full-access` are what a headless run depends on,
   * and a CLI that dropped either would leave Bento with no parseable
   * result or hang every card on an approval nobody is there to give.
   */
  await t.test("fx ask exposes the headless flags Bento uses", { skip: needsSprite() }, async () => {
    const help = await shell("fx ask --help");
    assert.equal(help.exitCode, 0, help.stderr);
    const text = `${help.out}\n${help.stderr}`;
    assert.match(text, /--json/);
    assert.match(text, /--full-access/);
    assert.match(text, /--resume/);
  });

  await t.test("installed fx resolves a custom Chat Completions connection", { skip: needsSprite() }, async () => {
    const configured = await shell(
      "tmp=$(mktemp -d); mkdir -p \"$tmp/.fx\"; " +
      "printf '%s' '{\"providers\":{\"bento-test\":{\"protocol\":\"openai-chat-completions\",\"base_url\":\"https://models.example.test/v1\",\"auth\":{\"type\":\"bearer\",\"env\":\"BENTO_CUSTOM_PROVIDER_API_KEY\"}}},\"models\":{\"bento-test\":\"chat-a\"}}' > \"$tmp/.fx/settings.json\"; " +
      "HOME=\"$tmp\" FX_PROVIDER=bento-test FX_MODEL=chat-a BENTO_CUSTOM_PROVIDER_API_KEY=sk-test fx doctor --json; status=$?; rm -rf \"$tmp\"; exit $status",
    );
    assert.equal(configured.exitCode, 0, configured.stderr);
    const result = JSON.parse(configured.out) as { model_source?: string; auth?: string; fail_count?: number };
    assert.equal(result.model_source, "bento-test");
    assert.equal(result.auth, "configured provider");
    assert.equal(result.fail_count, 0);
  });

  /**
   * Muse Code's echo provider needs no key and still emits the JSONL
   * envelope Bento's adapter reads: a session stream, output deltas,
   * and a completed terminal. That is the headless path a sandbox
   * actually runs, without spending a Meta key in CI.
   */
  await t.test("muse runs headlessly against its credential-free echo provider", { skip: needsSprite() }, async () => {
    const ran = await shell(
      "muse exec --json --yolo --user-input-auto-resolve --provider echo --workspace /workspace 'verify Bento integration'",
    );
    assert.equal(ran.exitCode, 0, ran.stderr || ran.stdout);
    assert.match(ran.out, /run\.terminal\.completed/);
    assert.match(ran.out, /verify Bento integration/);
    assert.match(ran.out, /"kind":\s*"session"/);
  });

  /**
   * pool is in AGENT_BINARIES, so install and --version are covered.
   * The flags Bento actually passes are what a headless run depends
   * on, and a CLI that dropped --unsafe-auto-allow would hang every
   * card on an approval nobody is there to give.
   */
  await t.test("pool exec exposes the headless flags Bento uses", { skip: needsSprite() }, async () => {
    const help = await shell("pool exec --help");
    assert.equal(help.exitCode, 0, help.stderr);
    const text = `${help.out}\n${help.stderr}`;
    assert.match(text, /--unsafe-auto-allow/);
    assert.match(text, /--sandbox/);
    assert.match(text, /-o|json/);
  });

  /**
   * The rule the sandbox design rests on: the Node that exists to run
   * pi is not the Node a repository gets.
   *
   * The first real run showed that only half of that promise is ours
   * to keep. A sprite ships its own node and npm at /.sprite/bin, on
   * the default PATH, so `node` in a workspace already means Fly's
   * rather than nothing at all, whatever this repository does. That is
   * a platform fact, not something a test here can assert away, and a
   * nightly that failed on it would be permanently red for a reason
   * nobody could act on.
   *
   * So what is asserted is the half this repository owns: the Node
   * installed here to run pi never becomes the one a project picks up.
   * What `node` does resolve to is printed rather than checked, so a
   * platform that changes its mind is visible in the log without
   * turning the run red.
   */
  await t.test("the private Node stays off the agent's PATH", { skip: needsSprite() }, async () => {
    const { out } = await shell("command -v node || echo absent; command -v npm || echo absent");
    console.log(`  node and npm resolve to: ${out.split("\n").join(", ")}`);
    assert.doesNotMatch(
      out,
      /\/opt\/bento\/node/,
      `the Node installed for pi became the one a project would use: ${out}`,
    );
    // pi still runs, which is the point of the shim.
    assert.equal((await shell("pi --version")).exitCode, 0);
  });

  await t.test("a warm provision does not reinstall anything", { skip: needsSprite() }, async () => {
    said.length = 0;
    const started = Date.now();
    await provision();
    const elapsed = Date.now() - started;
    assert.ok(
      said.some((message) => message.includes("already installed")),
      `a warm sprite should have skipped the install: ${said.join(" | ")}`,
    );
    assert.deepEqual(
      said.filter((message) => message.includes("Could not install")),
      [],
    );
    // Generous: this is a few round trips to the machine, not minutes
    // of installers. It is here to catch a reinstall, not to time one.
    assert.ok(elapsed < 3 * 60_000, `a warm provision took ${Math.round(elapsed / 1000)}s`);
  });

  /**
   * The workspace sweep, against the real filesystem API. The fix for
   * the artifacts directory rests on what that API answers for a
   * missing path (an unmapped "no such file or directory" the SDK
   * rethrows rather than a structured ENOENT), and only a live machine
   * can say whether that shape still holds: the stray directory below
   * forces the probe onto exactly that path, so an SDK or API that
   * changes its answer fails this provision the way every provision of
   * a real card would. The stub version of this test is in
   * sprite.test.ts; this is the one that cannot agree with the code by
   * construction.
   */
  await t.test("a warm provision sweeps around artifacts and strays, and reaps checkouts", { skip: needsSprite() }, async () => {
    // The abandoned .git carries a file, as every real one does: the
    // live API lists an empty directory as no entries at all, which
    // the SDK maps to ENOENT, so a bare mkdir'd .git reads as missing
    // and the checkout is (correctly, it is not one) left alone.
    const staged = await shell(
      [
        "mkdir -p /workspace/artifacts /workspace/stray /workspace/abandoned/.git",
        "printf 'ref: refs/heads/main\\n' > /workspace/abandoned/.git/HEAD",
        "printf 'kept' > /workspace/artifacts/mockup.html",
      ].join(" && "),
    );
    assert.equal(staged.exitCode, 0, `staging the workspace failed: ${staged.stderr}`);

    await provision();

    const { out } = await shell("for d in artifacts stray abandoned; do [ -d /workspace/$d ] && echo $d; done; cat /workspace/artifacts/mockup.html");
    assert.deepEqual(
      out.split("\n").filter(Boolean),
      ["artifacts", "stray", "kept"],
      "the sweep should keep artifacts and the stray directory, reap the abandoned checkout, and leave artifact files untouched",
    );
    await shell("rm -rf /workspace/stray /workspace/artifacts");
  });

  /**
   * The bug, reproduced against the real installers: a CLI that is not
   * there must come back, and only that one. Before the fix the marker
   * ended the script before it ever looked, so this sprite would have
   * stayed without opencode for the rest of the card's life and every
   * run of it would have died with "executable file `opencode` not
   * found in $PATH".
   */
  await t.test("a CLI that goes missing is reinstalled by the next provision", { skip: needsSprite() }, async () => {
    // Genuinely gone, rather than merely unlinked from one of the
    // places it can live. This one happened to pass against a list of
    // directories, because opencode's is on the list; three of its
    // neighbours are not, which is what the next subtest found.
    await uninstall(["opencode"]);
    const removed = await shell("command -v opencode");
    assert.notEqual(removed.exitCode, 0, "opencode should be gone before the provision that restores it");
    assert.deepEqual(
      (await present()).filter((binary) => binary === "opencode"),
      [],
    );

    said.length = 0;
    await provision();
    assert.deepEqual(
      said.filter((message) => message.includes("Could not install")),
      [],
    );
    assert.deepEqual(await present(), expected, "the missing CLI did not come back");
  });

  /**
   * The narrowing itself, against the real installers.
   *
   * Both halves matter, and they fail differently. Installing more than
   * was asked for only wastes the minutes this change exists to save.
   * Installing less is a run that dies at spawn with "executable file
   * not found in $PATH", which is the failure the whole file is here to
   * catch, so the CLIs are removed first and the sprite is asked
   * afterwards rather than the script's own report being believed.
   */
  await t.test("a provision installs the agents it was asked for, and no others", { skip: needsSprite() }, async () => {
    await uninstall(["codex", "opencode"]);
    await shell(`rm -f ${TOOLCHAIN_STAMPS}/codex ${TOOLCHAIN_STAMPS}/opencode`);
    const removed = await present();
    assert.deepEqual(
      removed.filter((binary) => binary === "codex" || binary === "opencode"),
      [],
      "the CLIs were not actually removed",
    );

    // A card whose pipeline runs Claude Code and Codex.
    said.length = 0;
    await provision(["claude", "codex"]);
    assert.deepEqual(
      said.filter((message) => message.includes("Could not install")),
      [],
    );
    const narrowed = await present();
    assert.ok(narrowed.includes("codex"), "an agent this card runs was not installed");
    assert.ok(!narrowed.includes("opencode"), "an agent this card never names was installed anyway");

    // Somebody adds an opencode stage to that pipeline. The provision
    // before the stage that needs it is where it arrives.
    said.length = 0;
    await provision(["claude", "codex", "opencode"]);
    assert.deepEqual(
      said.filter((message) => message.includes("Could not install")),
      [],
    );
    assert.deepEqual(await present(), expected, "an agent added to the pipeline later never arrived");
  });

  /**
   * What a TOOLCHAIN_VERSION bump looks like from inside the sandbox:
   * the marker it knows is gone, so the whole set installs again. This
   * is the run that matters most after a bump, because it is the one
   * where every warm sprite in the fleet reinstalls at once and the
   * installers are most likely to be throttled.
   */
  await t.test("a version bump reinstalls the set and leaves nothing missing", { skip: needsSprite() }, async () => {
    const forget = `rm -rf ${TOOLCHAIN_STAMPS} ${TOOLCHAIN_LEGACY_MARKER}`;
    assert.equal((await shell(`${forget}; test ! -d ${TOOLCHAIN_STAMPS}`)).exitCode, 0);

    said.length = 0;
    await provision();
    assert.ok(
      said.some((message) => message.includes("Installing the agent tools")),
      "a bumped marker should install rather than skip",
    );
    const failed = said.filter((message) => message.includes("Could not install"));
    assert.deepEqual(failed, [], `a bump left a CLI uninstalled: ${failed.join(" ")}`);
    assert.deepEqual(await present(), expected);
    const stamped = await shell(`ls ${TOOLCHAIN_STAMPS} 2>/dev/null | sort | tr '\\n' ' '`);
    assert.equal(stamped.out, expected.join(" "), "the bump did not stamp every CLI it reinstalled");
  });

  /**
   * Which of them need api.github.com, and which only look like
   * they might.
   *
   * opencode's installer asked that API which release was latest and
   * then refused to install without the answer, which cost every
   * sandbox its opencode for an hour at a time whenever a shared egress
   * address spent its sixty unauthenticated requests. opencode no
   * longer goes near it. Whether claude, codex, cursor or agy do is not
   * something their installers will say, and they are not published
   * anywhere they can be read: they are fetched from claude.ai,
   * chatgpt.com, cursor.com and antigravity.google and could change any
   * week.
   *
   * So the question is asked of the machine rather than of the source.
   * With that one host unreachable, and the CLIs and the marker gone,
   * a provision must still put the full set back. A failure here does not
   * mean this repository broke something. It means the CLI it names is
   * one busy hour away from being uninstallable, and wants the same
   * treatment opencode got: fetch the release, do not ask which one.
   */
  await t.test("every CLI installs with the GitHub API unreachable", { skip: needsSprite() }, async () => {
    const blackhole = "printf '127.0.0.1 api.github.com\\n' >> /etc/hosts";
    const restore = "sed -i '/api.github.com/d' /etc/hosts";
    try {
      assert.equal((await shell(blackhole)).exitCode, 0);
      // Confirm the block really took, so a test that passes cannot be
      // a test that never blocked anything.
      const reachable = await shell("curl -fsS -m 10 https://api.github.com/ >/dev/null 2>&1");
      assert.notEqual(reachable.exitCode, 0, "api.github.com was still reachable, so this proved nothing");

      // Everything gone: every CLI wherever it lives, and the marker,
      // so the whole set installs again. pi's private Node stays, since
      // it comes from npm rather than from GitHub and re-downloading it
      // tests nothing here.
      await uninstall(AGENT_BINARIES);
      await shell(`rm -rf ${TOOLCHAIN_STAMPS} ${TOOLCHAIN_LEGACY_MARKER}`);
      assert.deepEqual(await present(), [], "the CLIs were not actually removed");

      said.length = 0;
      await provision();
      const failed = said.filter((message) => message.includes("Could not install"));
      assert.deepEqual(failed, [], `these CLIs cannot be installed without the GitHub API: ${failed.join(" ")}`);
      assert.deepEqual(await present(), expected);
    } finally {
      await shell(restore);
    }
  });

  /**
   * The requests that hold a machine awake, against the real management
   * socket.
   *
   * Every detail of their shape came from documentation: the socket
   * path, the virtual host, the route, the body, the shorthand that
   * wraps all four. A wrong one fails the way the platform's own
   * behavior fails, which is silently. The hold is best effort by
   * design, so a run whose registration 404s keeps going, finishes its
   * quiet stretch, and dies to a pause exactly as if the fix had never
   * been written. Nothing in the stub suite can catch that, because a
   * stub answers whatever shape it is asked.
   *
   * So the production builder is run here, verbatim, and the machine is
   * asked what it did with it.
   */
  await t.test("the management socket accepts the requests that hold a sandbox awake", { skip: needsSprite() }, async () => {
    const name = "bento-e2e-probe";
    const listed = async () => (await shell(taskRequest("GET", "/v1/tasks"))).out;

    const registered = await shell(taskRequest("POST", "/v1/tasks", { name, expire: "5m" }));
    assert.equal(
      registered.exitCode,
      0,
      `the sandbox refused the registration that keeps it awake: ${registered.stderr || registered.out}`,
    );
    assert.match(await listed(), new RegExp(name), "the task was accepted but is not held");

    // Renewal is what carries a hold past the platform's per task cap,
    // so a run longer than that cap depends on this one answering.
    const renewed = await shell(taskRequest("PUT", `/v1/tasks/${name}`, { expire: "5m" }));
    assert.equal(renewed.exitCode, 0, `the sandbox refused a renewal: ${renewed.stderr || renewed.out}`);

    // And release, which is the difference between a machine that
    // pauses when the work is done and one that bills until it expires.
    const released = await shell(taskRequest("DELETE", `/v1/tasks/${name}`));
    assert.equal(released.exitCode, 0, `the sandbox refused to release the hold: ${released.stderr || released.out}`);
    assert.doesNotMatch(await listed(), new RegExp(name), "the hold outlived the release that was supposed to drop it");
  });

  /**
   * The bug itself, reproduced: a command that says nothing for longer
   * than the sandbox's idle window.
   *
   * This is what an agent looks like while a model is thinking, and it
   * is what killed the run this was written for. Without a hold the
   * machine pauses under the silence, the pause ends the process, and
   * the driver reports the exit it never got. The assertion is simply
   * that the command lived: a quiet stretch is not a dead one.
   *
   * Long enough to be past any plausible idle window, because the
   * window is the platform's to choose and a test tuned to today's
   * number would pass on a machine that had already stopped protecting
   * anything.
   */
  await t.test("a command that goes quiet outlives the sandbox's idle window", { skip: needsSprite() }, async () => {
    const quiet = 150;
    const started = Date.now();
    const result = await collectExec(
      driver.exec(handle, ["sh", "-c", `sleep ${quiet}; echo survived`], { timeoutMs: 5 * 60_000 }),
    );
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`  ${quiet}s of silence took ${elapsed}s and exited ${result.exitCode}`);

    assert.equal(
      result.exitCode,
      0,
      `a command that said nothing for ${quiet}s did not survive it: ${result.stderr.trim()}`,
    );
    assert.match(result.stdout, /survived/);
    // The two ways the old failure showed itself. Either means the hold
    // is not holding, whatever the exit code says.
    assert.doesNotMatch(result.stderr, /went to sleep/);
    assert.doesNotMatch(result.stderr, /closed before the command reported an exit/);
  });

  /**
   * A swarm's worker, provisioned the way a swarm actually provisions
   * one: from bundles rather than from a remote.
   *
   * This is the path no stub can check. A swarm's branch exists in
   * exactly one place, the machine its merge queue has been landing
   * onto, because a swarm pushes once and only at the end. So a worker
   * on a driver that clones from the remote cannot reach it: it is
   * seeded with a bundle of the base branch and a second, incremental
   * bundle carrying the swarm's branch, and its own work comes back
   * out as a third bundle for the queue to land.
   *
   * Every one of those three steps is git talking to git inside a real
   * machine, and the failures live in the seams: a bundle whose
   * prerequisite commit is not in the seed, a branch cut from the base
   * instead of from the swarm's head, an export that returns the
   * commits already on the base as well as the new ones. A stub agrees
   * with all of them.
   *
   * On the same sprite as everything above, deliberately. A second
   * machine would be a second name, and the workflow's cleanup deletes
   * one: a leaked sprite is billed until somebody notices.
   */
  await t.test("a worker seeded from bundles lands its work back out", { skip: needsSprite() }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bento-swarm-seed-"));
    try {
      const origin = path.join(root, "origin");
      await git(root, ["init", "--quiet", "-b", "main", origin]);
      await writeFile(path.join(origin, "totals.ts"), "export const total = 0;\n");
      await git(origin, ["add", "."]);
      await git(origin, ["commit", "--quiet", "-m", "base"]);
      const baseSha = (await git(origin, ["rev-parse", "HEAD"])).trim();

      // What the seed is: the base branch, whole.
      const seedPath = path.join(root, "seed.bundle");
      await git(origin, ["bundle", "create", seedPath, "main"]);

      /*
       * And what the swarm's branch is: a commit the remote has never
       * seen, carried as an incremental bundle whose prerequisite is
       * the base commit above. This is exactly what the merge queue
       * leaves behind after one leaf has landed.
       */
      await git(origin, ["checkout", "--quiet", "-b", "swarm/e2e"]);
      await writeFile(path.join(origin, "totals.ts"), "export const total = 1;\n");
      await git(origin, ["commit", "--quiet", "-am", "Line item totals"]);
      const swarmSha = (await git(origin, ["rev-parse", "HEAD"])).trim();
      const startPath = path.join(root, "start.bundle");
      await git(origin, ["bundle", "create", startPath, `${baseSha}..swarm/e2e`]);
      await git(origin, ["checkout", "--quiet", "main"]);

      await driver.provision({
        projectId: "sprite-e2e",
        workspaceKey,
        hostWorkspacePath: "/unused",
        repositories: [
          {
            name: "app",
            branch: "swarm/e2e-aaaaaaaa",
            baseBranch: "main",
            seedBundle: await readFile(seedPath),
            startBundle: { branch: "swarm/e2e", data: await readFile(startPath) },
          },
        ],
        onProgress: (message) => console.log(`  ${message}`),
      });

      /*
       * The worker's branch is cut from the swarm's head, not from the
       * base. This is the assertion the whole path exists for: a
       * worker that started from main would write against code the
       * swarm has already moved past, and its branch would conflict
       * with every leaf that landed before it.
       */
      const head = await shell("cd /workspace/app && git rev-parse HEAD");
      assert.equal(head.out, swarmSha, "the worker did not start from the swarm's branch");
      const file = await shell("cd /workspace/app && cat totals.ts");
      assert.equal(file.out, "export const total = 1;", "and the landed leaf's work is not in its checkout");
      const branch = await shell("cd /workspace/app && git rev-parse --abbrev-ref HEAD");
      assert.equal(branch.out, "swarm/e2e-aaaaaaaa", "the worker is not on its own branch");

      // Then the worker works, the way one does: a commit with the
      // trailer the merge queue matches on.
      const committed = await shell(
        [
          "cd /workspace/app",
          "printf 'export const total = 2;\\n' > totals.ts",
          "git add totals.ts",
          "git -c user.name=Worker -c user.email=w@localhost commit --quiet -m 'Round the total' -m 'Bento-Task: 11111111-2222-3333-4444-555555555555'",
          "git rev-parse HEAD",
        ].join("\n"),
      );
      assert.equal(committed.exitCode, 0, `the worker could not commit: ${committed.stderr || committed.out}`);

      /*
       * And the queue reads it back out. Incremental against the
       * swarm's branch rather than against the base, so what travels
       * is this leaf's commit and not the one that already landed.
       */
      const exported = await driver.exportRepository(handle, "app", "swarm/e2e");
      assert.ok(exported, "the worker's commit did not come back out of the machine");
      assert.equal(exported!.headSha, committed.out.split("\n").at(-1)!.trim());
      assert.equal(exported!.baseSha, swarmSha, "the export is against the base, not the swarm's branch");

      // The last step is the landing, so the bundle has to apply onto
      // the branch it says it is based on.
      const landing = path.join(root, "landing.bundle");
      await writeFile(landing, exported!.data);
      await git(origin, ["checkout", "--quiet", "swarm/e2e"]);
      await git(origin, ["bundle", "verify", landing]);
      await git(origin, ["fetch", "--quiet", landing, "HEAD"]);
      const fetched = (await git(origin, ["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      assert.equal(fetched, exported!.headSha, "what the bundle carried is not the commit it declared");
      assert.equal(
        (await git(origin, ["show", `${fetched}:totals.ts`])).trim(),
        "export const total = 2;",
        "the worker's change did not survive the trip out",
      );
      assert.match(
        await git(origin, ["log", "-1", "--format=%B", fetched]),
        /Bento-Task: 11111111-2222-3333-4444-555555555555/,
        "the trailer the merge queue matches on did not survive either",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The half of the lifecycle that costs money if it is wrong, so it is
   * asserted rather than left to a hook. A sprite is billed until it is
   * deleted, and nothing outside these tests deletes one: the server
   * has no call to driver.destroy at all, and destroy itself swallows
   * whatever the API says, so a delete that silently failed would look
   * from every side exactly like one that worked.
   *
   * Last, and a subtest of its own rather than an after hook, because a
   * failure here has to turn the run red. A hook that only logged would
   * be the same shape as the bug this whole branch is about: the one
   * line that knew, printed and thrown away.
   */
  await t.test("the sprite is deleted afterwards", { skip: needsSprite() }, async () => {
    await driver.destroy(handle);
    deleted = true;

    // Deletion is not always instant, so this asks for a while before
    // calling it a leak. It has a bound: an answer that never comes is
    // a machine still being billed, which is the thing worth failing on.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!(await exists())) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.fail(`${handle.externalId} still exists a minute after it was deleted, and is still being billed`);
  });
});
