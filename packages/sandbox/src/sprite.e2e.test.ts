import assert from "node:assert/strict";
import test from "node:test";
import { SpritesClient } from "@fly/sprites";
import { AGENT_BINARIES, TOOLCHAIN_MARKER } from "./agent-toolchain.js";
import { collectExec, type SandboxHandle } from "./driver.js";
import { taskRequest } from "./keep-awake.js";
import { SpriteDriver, spriteExists, spriteName } from "./sprite.js";

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
const featureId = `e2e-${runTag}`;

/** Long: a cold sprite installs five CLIs and a private Node. */
const PROVISION_TIMEOUT_MS = 25 * 60_000;

test("a real sprite ends up with every agent CLI, and heals when one goes missing", { skip }, async (t) => {
  const driver = new SpriteDriver({ token: token!, timeoutMs: PROVISION_TIMEOUT_MS });
  const handle: SandboxHandle = {
    externalId: spriteName(featureId),
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
   */
  const client = new SpritesClient(token!, { timeout: 60_000 });
  const exists = () => spriteExists(client, handle.externalId);

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
  const provision = () =>
    driver.provision({
      projectId: "sprite-e2e",
      featureId,
      hostWorkspacePath: "/unused",
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
   * deleted from those. It missed three of the five: the sprite's HOME
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
   * What a TOOLCHAIN_VERSION bump looks like from inside the sandbox:
   * the marker it knows is gone, so the whole set installs again. This
   * is the run that matters most after a bump, because it is the one
   * where every warm sprite in the fleet reinstalls at once and the
   * installers are most likely to be throttled.
   */
  await t.test("a version bump reinstalls the set and leaves nothing missing", { skip: needsSprite() }, async () => {
    assert.equal((await shell(`rm -f ${TOOLCHAIN_MARKER}; test ! -f ${TOOLCHAIN_MARKER}`)).exitCode, 0);

    said.length = 0;
    await provision();
    assert.ok(
      said.some((message) => message.includes("Installing the agent tools")),
      "a bumped marker should install rather than skip",
    );
    const failed = said.filter((message) => message.includes("Could not install"));
    assert.deepEqual(failed, [], `a bump left a CLI uninstalled: ${failed.join(" ")}`);
    assert.deepEqual(await present(), expected);
    assert.equal((await shell(`test -f ${TOOLCHAIN_MARKER}`)).exitCode, 0, "the marker was not rewritten");
  });

  /**
   * Which of the five need api.github.com, and which only look like
   * they might.
   *
   * opencode's installer asked that API which release was latest and
   * then refused to install without the answer, which cost every
   * sandbox its opencode for an hour at a time whenever a shared egress
   * address spent its sixty unauthenticated requests. opencode no
   * longer goes near it. Whether claude, codex or cursor do is not
   * something their installers will say, and they are not published
   * anywhere they can be read: they are fetched from claude.ai,
   * chatgpt.com and cursor.com and could change any week.
   *
   * So the question is asked of the machine rather than of the source.
   * With that one host unreachable, and the CLIs and the marker gone,
   * a provision must still put all five back. A failure here does not
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
      await shell(`rm -f ${TOOLCHAIN_MARKER}`);
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
