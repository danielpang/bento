import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_BINARIES, TOOLCHAIN_MARKER } from "./agent-toolchain.js";
import { collectExec, type SandboxHandle } from "./driver.js";
import { SpriteDriver, spriteName } from "./sprite.js";

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
 * A name nobody else is using. Sprites are one per feature and live
 * until deleted, so a fixed name would have two concurrent runs
 * fighting over one machine, and the loser would report failures that
 * are really the other run's cleanup.
 */
const featureId = `e2e-${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.pid}`;

/** Long: a cold sprite installs five CLIs and a private Node. */
const PROVISION_TIMEOUT_MS = 25 * 60_000;

test("a real sprite ends up with every agent CLI, and heals when one goes missing", { skip }, async (t) => {
  const driver = new SpriteDriver({ token: token!, timeoutMs: PROVISION_TIMEOUT_MS });
  const handle: SandboxHandle = {
    externalId: spriteName(featureId),
    provider: "sprite",
    workdir: "/workspace",
  };

  // Registered before the machine exists, so provisioning that throws
  // halfway still takes its sprite with it. A leaked sprite is a
  // machine that goes on being billed.
  t.after(async () => {
    await driver.destroy(handle).catch((err: unknown) => {
      console.error(`could not delete the test sprite ${handle.externalId}:`, err);
    });
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
   * Everything below the first check needs a machine to talk to, so a
   * sprite that never came up would otherwise report the same failure
   * five times over and bury the one that happened. This runs
   * unattended overnight; the report has to be readable in the morning.
   */
  let up = false;
  const needsSprite = () => (up ? false : "the sprite never came up");

  await t.test("a cold provision installs the whole set", async () => {
    const cold = await provision();
    assert.equal(cold.externalId, handle.externalId);
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
   * pi is not the Node a repository gets. Checked here rather than only
   * by reading the script, because a future installer that helpfully
   * adds itself to /usr/local/bin would break it silently.
   */
  await t.test("the private Node stays off the agent's PATH", { skip: needsSprite() }, async () => {
    const { out } = await shell("command -v node || echo absent; command -v npm || echo absent");
    assert.deepEqual(out.split("\n"), ["absent", "absent"], `a project's Node was decided for it: ${out}`);
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
   * The bug, reproduced against the real installers: a CLI that is not
   * there must come back, and only that one. Before the fix the marker
   * ended the script before it ever looked, so this sprite would have
   * stayed without opencode for the rest of the card's life and every
   * run of it would have died with "executable file `opencode` not
   * found in $PATH".
   */
  await t.test("a CLI that goes missing is reinstalled by the next provision", { skip: needsSprite() }, async () => {
    // Every directory publish() links from, so the CLI is genuinely
    // gone rather than merely unlinked from one of them.
    const removed = await shell(
      "rm -f /usr/local/bin/opencode /root/.opencode/bin/opencode /root/.local/bin/opencode" +
        " /opt/bento/bin/opencode; command -v opencode",
    );
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
});
