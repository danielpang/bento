import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_BINARIES,
  AGENT_CLI_BINARIES,
  AGENT_TOOLCHAIN_SCRIPT,
  TOOLCHAIN_LEGACY_MARKER,
  TOOLCHAIN_STAMPS,
  TOOLCHAIN_VERSION,
  agentToolchainScript,
  toolchainBinaries,
  toolchainMissing,
  toolchainPresenceProbe,
} from "./agent-toolchain.js";

const dockerfile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../infra/sandbox-image/Dockerfile",
);

/**
 * Two places install the agent CLIs, because two things need them: the
 * Docker image is built ahead of time, and a sprite is a bare machine
 * installed on first use. They have already drifted once, when pi
 * shipped as an adapter and only one of them learned about it, which
 * failed at exec with "not found" and no clue why.
 */
test("the Docker image installs every CLI the Sprite script does", async () => {
  const image = await readFile(dockerfile, "utf8");
  for (const binary of AGENT_BINARIES) {
    assert.match(image, new RegExp(binary), `the sandbox image never mentions ${binary}`);
  }
});

/**
 * The rule the whole design rests on: a sandbox has git, and no
 * language runtime for the project. The one Node here exists to run pi
 * and is deliberately kept off the PATH an agent's shell sees.
 */
test("the toolchain installs git and keeps its private Node off the PATH", () => {
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /packages="\$packages git"/);
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /\/opt\/bento\/node/);
  // Every mention of the private Node directory is either the install
  // itself or the shim that scopes it to one process; none of them puts
  // it on the PATH the sandbox exports.
  for (const line of AGENT_TOOLCHAIN_SCRIPT.split("\n")) {
    if (!line.includes("/opt/bento/node/bin") || line.trim().startsWith("#")) continue;
    assert.match(
      line,
      /PATH=\/opt\/bento\/node\/bin:\$PATH|\/opt\/bento\/node\/bin\/(node|npm)|-x \/opt\/bento\/node\/bin\/node|mkdir/,
      `unexpected use of the private Node: ${line}`,
    );
  }
  assert.doesNotMatch(AGENT_TOOLCHAIN_SCRIPT, /export PATH=.*opt\/bento\/node/);
});

test("dsh is pinned, configured, and initialized for headless sandbox use", async () => {
  assert.equal(TOOLCHAIN_VERSION, 3, "adding dsh must not stampede warm machines with a version bump");
    assert.match(AGENT_TOOLCHAIN_SCRIPT, /@deepseek-ai\/dsh@0\.1\.1-rc\.2/);
    assert.match(AGENT_TOOLCHAIN_SCRIPT, /@deepseek-ai\/cordis-plugin-hmr@1\.0\.17/);
    assert.match(AGENT_TOOLCHAIN_SCRIPT, /version_below "\$ver" "1\.14\.24"/);
    assert.match(AGENT_TOOLCHAIN_SCRIPT, /version_below "\$ver" "0\.70\.1"/);
    assert.match(AGENT_TOOLCHAIN_SCRIPT, /dsh-hmr-pin/);
    assert.match(AGENT_TOOLCHAIN_SCRIPT, /bento-wait-for-hmr/);

  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-dsh-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.equal(
      readFileSync(path.join(root, "opt/bento/dsh-home/cordis.patch.yml"), "utf8"),
      `- id: agent-default-model
  config:
    provider: deepseek-official
    model: !!js process.env.DSH_MODEL
- id: tool-web
  disabled: true
`,
    );
    assert.match(readFileSync(path.join(root, "npm-installs"), "utf8"), /^@deepseek-ai\/dsh@0\.1\.1-rc\.2$/m);
    assert.match(readFileSync(path.join(root, "npm-installs"), "utf8"), /^@deepseek-ai\/cordis-plugin-hmr@1\.0\.17$/m);
    assert.equal(readFileSync(path.join(root, "opt/bento/dsh-hmr-pin"), "utf8").trim(), "1.0.17+wait");
    assert.equal(
      readFileSync(path.join(root, "dsh-runs"), "utf8").trim(),
      "deepseek-v4-pro|danger-full-access|1|--profile headless --dump-config",
    );
    const shim = readFileSync(path.join(root, "usr/local/bin/dsh"), "utf8");
    assert.match(shim, /mktemp -d /);
    assert.match(shim, /dsh-runs\/XXXXXX/);
    assert.match(shim, /cp -a /);
    const probe = spawnSync(path.join(root, "usr/local/bin/dsh"), ["hello"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: path.join(root, "home") },
    });
    assert.equal(probe.status, 0, probe.stderr);
    const homes = readdirSync(path.join(root, "opt/bento/dsh-runs"));
    assert.equal(homes.length, 1, `expected one per-run home, got ${homes.join(" ")}`);
    assert.equal(
      readFileSync(path.join(root, "opt/bento/dsh-runs", homes[0], "cordis.patch.yml"), "utf8"),
      readFileSync(path.join(root, "opt/bento/dsh-home/cordis.patch.yml"), "utf8"),
    );

    const image = await readFile(dockerfile, "utf8");
    for (const required of [
      "BENTO_NODE_VERSION=22.22.2",
      "@deepseek-ai/dsh@0.1.1-rc.2",
      "@deepseek-ai/cordis-plugin-hmr@1.0.17",
      "1.0.17+wait",
      "bento-wait-for-hmr",
      "/opt/bento/dsh-hmr-pin",
      "exec /opt/bento/dsh/bin/dsh",
      "for tool in agy claude codex cursor-agent dsh fx muse opencode pi pool",
      "model: !!js process.env.DSH_MODEL",
      "provider: deepseek-official",
      "DSH_PERMISSION_MODE=danger-full-access",
      "DSH_TELEMETRY_DISABLED=1",
      "dsh --profile headless --dump-config",
    ]) {
      assert.ok(image.includes(required), `the Docker image is missing ${required}`);
    }
    for (const required of [
      "mkdir -p /opt/bento/dsh-runs",
      "mktemp -d /opt/bento/dsh-runs/XXXXXX",
      "cp -a /opt/bento/dsh-home/.",
      "DSH_HOME=/opt/bento/dsh-home DSH_MODEL=deepseek-v4-pro",
    ]) {
      assert.ok(AGENT_TOOLCHAIN_SCRIPT.includes(required), `the Sprite script is missing ${required}`);
      assert.ok(image.includes(required), `the Docker image is missing ${required}`);
    }
    assert.doesNotMatch(image, /ENV PATH=.*\/opt\/bento\/node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Muse Code is a standalone binary, same as pool and agy. Adding it
 * must not bump TOOLCHAIN_VERSION: a warm sprite holding the v3 marker
 * finds muse absent from the PATH, installs that one CLI, and leaves
 * the rest alone.
 */
test("adding muse does not bump TOOLCHAIN_VERSION", async () => {
  assert.equal(TOOLCHAIN_VERSION, 3, "adding muse must not stampede warm machines with a version bump");
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /https:\/\/dev\.meta\.ai\/install\.sh/);
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /MUSE_NO_MODIFY_PATH=1/);
  const image = await readFile(dockerfile, "utf8");
  assert.ok(image.includes("https://dev.meta.ai/install.sh"), "the Docker image never installs muse");
  assert.ok(image.includes("MUSE_NO_MODIFY_PATH=1"), "the Docker image rewrites shell rc files");
  assert.ok(
    image.includes("for tool in agy claude codex cursor-agent dsh fx muse opencode pi pool"),
    "the Docker image PATH check never mentions muse",
  );
});

/**
 * fx is a standalone binary, same as muse. Adding it must not bump
 * TOOLCHAIN_VERSION: a warm sprite holding the v3 marker finds fx
 * absent from the PATH, installs that one CLI, and leaves the rest
 * alone.
 */
test("adding fx does not bump TOOLCHAIN_VERSION", async () => {
  assert.equal(TOOLCHAIN_VERSION, 3, "adding fx must not stampede warm machines with a version bump");
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /https:\/\/fx\.sh\/setup\.sh/);
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /fx" upgrade --channel dev --json/);
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /FX_CUSTOM_MARKER=\/opt\/bento\/fx-custom-connections/);
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /FX_INSTALL_DIR=/);
  const image = await readFile(dockerfile, "utf8");
  assert.ok(image.includes("https://fx.sh/setup.sh"), "the Docker image never installs fx");
  assert.ok(image.includes("upgrade --channel dev --json"), "the Docker image needs fx custom connections");
  assert.ok(image.includes("FX_INSTALL_DIR="), "the Docker image lets the installer pick its own bin dir");
  assert.ok(
    image.includes("for tool in agy claude codex cursor-agent dsh fx muse opencode pi pool"),
    "the Docker image PATH check never mentions fx",
  );
});

test("a warm machine upgrades only fx when custom connections are missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-fx-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.equal(sandbox.run().status, 0);
    const marker = path.join(root, "opt/bento/fx-custom-connections");
    assert.equal(existsSync(marker), true);
    rmSync(marker);
    const upgraded = sandbox.run();
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.deepEqual(sandbox.fetched(), ["https://fx.sh/setup.sh"]);
    assert.equal(existsSync(marker), true);
    assert.deepEqual(toolchainMissing(upgraded.stdout), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Antigravity's default credential is a Google account, and a sandbox
 * has no browser to sign in with. `modelProvider: "gemini"` is what
 * redirects it to GEMINI_API_KEY, and the CLI refuses to start with one
 * of the two and not the other, so the setting has to be on disk before
 * the first run rather than arriving with it.
 *
 * The file is written only when there is none. A local user who shares
 * their own ~/.gemini has it mounted over this, read only, and their
 * settings are the ones that should decide; overwriting it would also
 * fail the exec on a mount nothing can write to.
 */
test("agy is installed with the settings that make an API key its credential", async () => {
  const image = await readFile(dockerfile, "utf8");
  for (const required of [
    "https://antigravity.google/cli/install.sh",
    '{ "modelProvider": "gemini" }',
  ]) {
    assert.ok(AGENT_TOOLCHAIN_SCRIPT.includes(required), `the Sprite script is missing ${required}`);
    assert.ok(image.includes(required), `the Docker image is missing ${required}`);
  }

  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-agy-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    const first = sandbox.run();
    assert.equal(first.status, 0, first.stderr);
    const settings = path.join(root, "home/.gemini/antigravity-cli/settings.json");
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { modelProvider: "gemini" });

    // A settings file already there is left exactly as it was, which is
    // what makes a mounted ~/.gemini authoritative.
    writeFileSync(settings, '{ "modelProvider": "signed-in" }');
    rmSync(path.join(root, "usr/local/bin/agy"), { force: true });
    rmSync(path.join(root, "home/.local/bin/agy"), { force: true });
    const second = sandbox.run();
    assert.equal(second.status, 0, second.stderr);
    assert.ok(sandbox.published().includes("agy"), "agy was not reinstalled after being removed");
    assert.equal(readFileSync(settings, "utf8"), '{ "modelProvider": "signed-in" }');

    // Its installer documents ~/.local/bin, which is where the stub
    // above puts it, but an installer that moves is the failure mode
    // this whole file exists for: nothing shows a symptom until a card
    // runs that agent. Its own directory is searched too, so a move
    // there costs nothing.
    rmSync(path.join(root, "usr/local/bin/agy"), { force: true });
    rmSync(path.join(root, "home/.local/bin/agy"), { force: true });
    mkdirSync(path.join(root, "home/.antigravity/bin"), { recursive: true });
    writeFileSync(path.join(root, "home/.antigravity/bin/agy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const third = sandbox.run();
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(toolchainMissing(third.stdout), [], "agy in its own directory was not put on the PATH");
    assert.deepEqual(sandbox.fetched(), [], "a binary already on the machine must not be downloaded again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * `curl | sh` reports the shell's exit status, not the download's, so a
 * fetch that answers 403 hands an empty script to a shell that exits 0.
 * Every installer here is downloaded first and run second, which is
 * what makes a failed fetch a failed install.
 */
test("no installer is piped straight into a shell", async () => {
  assert.doesNotMatch(AGENT_TOOLCHAIN_SCRIPT, /curl[^\n]*\|\s*(ba)?sh/);
  assert.doesNotMatch(await readFile(dockerfile, "utf8"), /curl[^\n]*\|\s*(ba)?sh/);
});

test("the script parses as POSIX sh", () => {
  const check = spawnSync("sh", ["-n"], { input: AGENT_TOOLCHAIN_SCRIPT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("the missing line names the CLIs that are not there, and nothing when they all are", () => {
  assert.deepEqual(toolchainMissing("bento-toolchain-missing: opencode pi \n"), ["opencode", "pi"]);
  assert.deepEqual(toolchainMissing("some other output\n"), []);
});

/**
 * The bug this file exists to keep fixed.
 *
 * The marker used to mean "the install ran", and it was written whether
 * the CLIs landed or not. So a sandbox that lost one installer to a bad
 * minute (opencode's asks the GitHub API which release is latest, and
 * that API rate limits a shared egress address) skipped straight past
 * it on every later provision, and every run of that agent died at
 * spawn with the runtime's own words: "executable file `opencode` not
 * found in $PATH".
 *
 * Run for real rather than pattern matched, because the earlier version
 * satisfied every reasonable reading of the script and still wedged the
 * sandbox. The script is relocated under a temporary root and given
 * stub installers, so nothing here touches the machine running the
 * test; the guard below fails if a future edit adds a path that would
 * escape the relocation.
 */
test("an installer that fails once is retried on the next provision, and the rest are not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-"));
  try {
    const sandbox = new ToolchainSandbox(root);

    // First provision, with both of opencode's routes down: the
    // installer and the release it falls back to. Both, because one
    // alone no longer leaves the CLI missing, which is the point of the
    // fallback.
    sandbox.breaks("opencode", "opencode-release");
    const first = sandbox.run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(toolchainMissing(first.stdout), ["opencode"]);
    assert.match(first.stderr, /opencode install failed/);
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "pi", "pool"]);
    // Not once and given up on: a blip passes within seconds. Both
    // routes get their three, the release first and the installer only
    // once that has failed.
    assert.equal(sandbox.fetched().filter((url) => url.includes("releases/latest/download")).length, 3);
    assert.equal(sandbox.fetched().filter((url) => url === "https://opencode.ai/install").length, 3);

    // Second provision, with both reachable again. Only the CLI that is
    // missing is fetched; the four that are there are not reinstalled,
    // which is what keeps a warm sandbox warm.
    sandbox.breaks();
    const second = sandbox.run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(toolchainMissing(second.stdout), []);
    // Exactly one fetch, and it is the release: the CLI that was
    // missing, by the route that does not need the API.
    assert.equal(sandbox.fetched().length, 1);
    assert.match(sandbox.fetched()[0] ?? "", /releases\/latest\/download\/opencode-linux-/);
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"]);

    // Third provision, with everything in place: no network at all.
    const third = sandbox.run();
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(sandbox.fetched(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine upgrades an old private Node while installing only missing dsh", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-node-upgrade-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    // This fixture contains an x64 archive, including when tests run on an ARM Mac.
    writeFileSync(path.join(root, "stubs/uname"), "#!/bin/sh\nprintf 'x86_64\\n'\n", { mode: 0o755 });
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    rmSync(path.join(root, "opt/bento/dsh"), { recursive: true, force: true });
    rmSync(path.join(root, "usr/local/bin/dsh"), { force: true });
    const node = path.join(root, "opt/bento/node/bin/node");
    writeFileSync(node, "#!/bin/sh\nprintf 'v22.14.0\\n'\n");
    chmodSync(node, 0o755);

    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.fetched(), [
      "https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz",
    ]);
    assert.equal(spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(), "v22.22.2");
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine keeps a newer dsh-compatible private Node", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-node-current-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    rmSync(path.join(root, "opt/bento/dsh"), { recursive: true, force: true });
    rmSync(path.join(root, "usr/local/bin/dsh"), { force: true });
    const node = path.join(root, "opt/bento/node/bin/node");
    writeFileSync(node, "#!/bin/sh\nprintf 'v24.3.0\\n'\n");
    chmodSync(node, 0o755);

    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.fetched(), []);
    assert.equal(spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(), "v24.3.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine reinstalls only opencode when it is too old for native DeepSeek", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-opencode-stale-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    writeCliVersion(path.join(root, "home/.opencode/bin/opencode"), "1.10.0");
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.equal(sandbox.fetched().length, 1);
    assert.match(sandbox.fetched()[0] ?? "", /releases\/latest\/download\/opencode-linux-/);
    assert.equal(
      spawnSync(path.join(root, "home/.opencode/bin/opencode"), ["--version"], { encoding: "utf8" }).stdout.trim(),
      "99.0.0",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine reinstalls only pi when it is too old for native DeepSeek", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-pi-stale-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    writeCliVersion(path.join(root, "opt/bento/pi/bin/pi"), "0.50.0");
    rmSync(path.join(root, "npm-installs"), { force: true });
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.fetched(), []);
    const installs = readFileSync(path.join(root, "npm-installs"), "utf8");
    assert.match(installs, /@earendil-works\/pi-coding-agent/);
    assert.doesNotMatch(installs, /dsh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine reinstalls dsh when the HMR plugin pin is missing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-dsh-hmr-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);
    rmSync(path.join(root, "opt/bento/dsh-hmr-pin"));
    rmSync(path.join(root, "npm-installs"), { force: true });
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    const installs = readFileSync(path.join(root, "npm-installs"), "utf8");
    assert.match(installs, /@deepseek-ai\/dsh@0\.1\.1-rc\.2/);
    assert.match(installs, /@deepseek-ai\/cordis-plugin-hmr@1\.0\.17/);
    assert.doesNotMatch(installs, /pi-coding-agent/);
    assert.equal(readFileSync(path.join(root, "opt/bento/dsh-hmr-pin"), "utf8").trim(), "1.0.17+wait");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine reinstalls only dsh when the installed pin does not match", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-dsh-stale-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    writeCliVersion(path.join(root, "opt/bento/dsh/bin/dsh"), "0.1.0");
    rmSync(path.join(root, "npm-installs"), { force: true });
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.fetched(), []);
    const installs = readFileSync(path.join(root, "npm-installs"), "utf8");
    assert.match(installs, /@deepseek-ai\/dsh@0\.1\.1-rc\.2/);
    assert.doesNotMatch(installs, /pi-coding-agent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm machine with current opencode, pi, and dsh versions fetches nothing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-current-clis-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(sandbox.fetched(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The failure that actually happened, twice, and the reason opencode no
 * longer goes through its installer at all.
 *
 * That installer asks api.github.com which release is latest and exits
 * without installing when the call fails. It fails for an hour at a
 * time, because that is the window an address gets sixty
 * unauthenticated requests in, and a pool of sprites shares one
 * address. No retry worth writing waits out an hour, so the answer is
 * not to need the API: /releases/latest/download serves the newest
 * build without it, and without a version number.
 */
test("opencode comes from its release, never asking which version that is", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-release-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    // The installer is down, as it is for an hour at a time. Nothing
    // should notice.
    sandbox.breaks("opencode");
    const result = sandbox.run();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"]);
    assert.ok(
      sandbox.fetched().some((url) => url.includes("releases/latest/download/opencode-linux-")),
      `the release was never fetched: ${sandbox.fetched().join(" ")}`,
    );
    // Not merely tolerated: not consulted. The installer is the one
    // thing here that can be rate limited, so the ordinary path must
    // not touch it.
    assert.ok(
      !sandbox.fetched().includes("https://opencode.ai/install"),
      "the rate limited installer was fetched on the ordinary path",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The installer earns its place only for the day upstream moves the
 * release: a renamed asset or another change of GitHub organization
 * 404s the download, and the vendor's own script can still be right.
 */
test("opencode falls back to its installer when the release download is gone", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-moved-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    sandbox.breaks("opencode-release");
    const result = sandbox.run();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"]);
    assert.ok(sandbox.fetched().includes("https://opencode.ai/install"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A version bump is the riskiest moment this script has, and the one
 * most likely to bring the bug back.
 *
 * Bumping renames the marker, so every warm sandbox in the fleet
 * reinstalls the whole set on its next provision, all at once, from one
 * egress address. That is exactly the condition that gets an installer
 * throttled, so a bump makes a failed install more likely rather than
 * less. What must not follow is the old behaviour: the CLI that lost
 * its install during the stampede staying gone.
 */
test("a bump reinstalls the set, and still retries a CLI the bump could not install", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-bump-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    // A machine that never got opencode, which is the state the fleet
    // is in when a bump lands after a bad hour. Both of its routes are
    // down, since either one alone would install it.
    sandbox.breaks("opencode", "opencode-release");
    const first = sandbox.run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(toolchainMissing(first.stdout), ["opencode"]);

    // The bump, with opencode still unreachable while every warm
    // machine reinstalls at once.
    const bumped = sandbox.runAfterVersionBump();
    assert.equal(bumped.status, 0, bumped.stderr);
    // A bump means the whole set, not only what is missing: the point
    // of bumping is that the CLIs already there may be too old.
    for (const installer of ["claude", "codex", "opencode", "cursor", "poolside", "meta.ai"]) {
      assert.ok(
        sandbox.fetched().some((url) => url.includes(installer)),
        `a bump did not reinstall ${installer}: ${sandbox.fetched().join(" ")}`,
      );
    }
    assert.deepEqual(toolchainMissing(bumped.stdout), ["opencode"]);
    // The four that did install are still usable. A bump that fails
    // halfway must not take the working CLIs down with it.
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "pi", "pool"]);

    // The provision after the bump. This is the assertion that would
    // have caught the original bug: the new marker is on disk, and it
    // must not be enough to end the script while a CLI is absent.
    sandbox.breaks();
    const after = sandbox.runAfterVersionBump();
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(toolchainMissing(after.stdout), []);
    assert.equal(after.status, 0);
    assert.equal(sandbox.fetched().length, 1);
    assert.match(sandbox.fetched()[0] ?? "", /releases\/latest\/download\/opencode-linux-/);
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The other half of a bump, written down because it is a deliberate
 * limit rather than an oversight: a machine that already has a CLI
 * keeps the copy it has when the reinstall cannot reach it at all.
 *
 * Nothing breaks, and the sandbox stays usable, but the upgrade the
 * bump existed to deliver did not happen and the script cannot tell.
 * Catching a stale binary used to mean knowing each CLI's version and
 * how to ask for it. opencode, pi, and dsh now do that on a warm
 * machine (DeepSeek floors and the dsh pin). A bump remains the way
 * the other CLIs refresh. What this still guarantees for every tool
 * is the part that matters for a run: a CLI is either there or reported.
 */
test("a bump that cannot reach a CLI keeps the copy the machine already had", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-stale-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    sandbox.breaks("opencode", "opencode-release");
    const bumped = sandbox.runAfterVersionBump();
    assert.equal(bumped.status, 0, bumped.stderr);
    assert.deepEqual(toolchainMissing(bumped.stdout), [], "the previously installed copy is still there");
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "opencode", "pi", "pool"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Adding a seventh CLI means adding something that installs it. Without
 * this, a binary added to the list alone would leave every provision
 * installing nothing, reporting it missing, and trying again forever.
 */
test("every binary the script promises has something that installs it", () => {
  for (const binary of AGENT_BINARIES) {
    assert.ok(
      new RegExp(`install_from ${binary}\\b`).test(AGENT_TOOLCHAIN_SCRIPT) ||
        new RegExp(`wanted ${binary}\\b`).test(AGENT_TOOLCHAIN_SCRIPT),
      `${binary} is in AGENT_BINARIES but nothing in the script installs it`,
    );
  }
});

/** Both routes down is still reported, not silently swallowed. */
test("opencode is reported missing when the release and the installer are both unreachable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-bothdown-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    sandbox.breaks("opencode", "opencode-release");
    const result = sandbox.run();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), ["opencode"]);
    assert.match(result.stderr, /opencode release download failed/);
    // And the other four are unharmed.
    assert.deepEqual(sandbox.published(), ["agy", "claude", "codex", "cursor-agent", "dsh", "fx", "muse", "pi", "pool"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Runs the real script against stub installers inside a temporary root.
 *
 * Every absolute path the script writes to is rewritten to sit under
 * that root, and the PATH it runs with puts stubs for curl, git and
 * apt-get ahead of everything else, so a test run installs nothing and
 * changes nothing outside its own directory.
 */
class ToolchainSandbox {
  private script: string;
  private stubs: string;

  constructor(private root: string) {
    this.stubs = path.join(root, "stubs");
    this.script = this.relocate(AGENT_TOOLCHAIN_SCRIPT);

    mkdirSync(this.stubs, { recursive: true });
    // The real /tmp exists; the relocated one has to be made.
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    this.stub("git", "exit 0");
    this.stub("apt-get", "exit 0");
    this.stub("sleep", "exit 0");

    // A real release tarball for the fallback to unpack, so the test
    // exercises the tar and the move rather than trusting them.
    const fixtures = path.join(root, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(path.join(fixtures, "opencode"), "#!/bin/sh\nprintf '99.0.0\\n'\n");
    spawnSync("tar", ["-czf", path.join(fixtures, "opencode.tar.gz"), "-C", fixtures, "opencode"]);
    this.breaks();

    // The shared private Node, already unpacked, so the npm stub is all the
    // rest of that branch needs.
    const nodeBin = path.join(root, "opt/bento/node/bin");
    mkdirSync(nodeBin, { recursive: true });
    this.write(path.join(nodeBin, "node"), "#!/bin/sh\nprintf 'v22.22.2\\n'\n");
    this.write(
      path.join(nodeBin, "npm"),
      `#!/bin/sh
prefix=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; shift 2; continue; fi
  case "$1" in
    -*) shift; continue ;;
    @*) ;;
    *) shift; continue ;;
  esac
  package=$1
  shift
  case "$package" in
    @deepseek-ai/dsh@*) binary=dsh ;;
    @deepseek-ai/cordis-plugin-hmr@*) binary= ;;
    @earendil-works/pi-coding-agent) binary=pi ;;
    *) exit 1 ;;
  esac
  printf '%s\\n' "$package" >> ${root}/npm-installs
  [ -n "$binary" ] || continue
  mkdir -p "$prefix/bin"
  cat > "$prefix/bin/$binary" <<'EOF'
#!/bin/sh
case "$1" in
  --version|-V)
    if [ "$(basename "$0")" = dsh ]; then
      printf '%s\\n' '0.1.1-rc.2'
    else
      printf '%s\\n' '99.0.0'
    fi
    exit 0
    ;;
esac
printf '%s\\n' "\${DSH_MODEL:-}|\${DSH_PERMISSION_MODE:-}|\${DSH_TELEMETRY_DISABLED:-}|\$*" >> ${root}/dsh-runs
EOF
  chmod +x "$prefix/bin/$binary"
done
`,
    );

    const nodeFixture = path.join(fixtures, "node-v22.22.2-linux-x64");
    mkdirSync(path.join(nodeFixture, "bin"), { recursive: true });
    this.write(path.join(nodeFixture, "bin/node"), "#!/bin/sh\nprintf 'v22.22.2\\n'\n");
    this.write(path.join(nodeFixture, "bin/npm"), readFileSync(path.join(nodeBin, "npm"), "utf8"));
    spawnSync("tar", ["-cJf", path.join(fixtures, "node.tar.xz"), "-C", fixtures, path.basename(nodeFixture)]);
  }

  /** Names the installers that answer with a failure rather than a script. */
  breaks(...broken: string[]): void {
    this.stub(
      "curl",
      `for arg in "$@"; do
  case "$arg" in
    -o) next=out ;;
    http*) url="$arg" ;;
    *) if [ "\${next:-}" = out ]; then out="$arg"; next=; fi ;;
  esac
done
echo "$url" >> ${this.root}/fetched
case "$url" in
  *nodejs.org/dist/*)
    cp ${this.root}/fixtures/node.tar.xz "$out"
    exit 0
    ;;
  # The release tarball the opencode fallback fetches, which is a real
  # gzipped tar carrying a file called opencode, not an installer.
  *releases/latest/download/*)
    for broken in ${broken.join(" ")}; do
      if [ "$broken" = opencode-release ]; then exit 22; fi
    done
    cp ${this.root}/fixtures/opencode.tar.gz "$out"
    exit 0
    ;;
  *opencode*) tool=opencode ;;
  *claude*) tool=claude ;;
  *codex*) tool=codex ;;
  *cursor*) tool=cursor-agent ;;
  *antigravity*) tool=agy ;;
  *poolside*) tool=pool ;;
  *dev.meta.ai*|*muse-launcher*) tool=muse ;;
  *fx.sh*) tool=fx ;;
  *) exit 22 ;;
esac
for broken in ${broken.join(" ")}; do
  if [ "$broken" = "$tool" ]; then exit 22; fi
done
cat > "$out" <<EOF
#!/bin/sh
# pool's real installer refuses a headless run unless the EULA is
# accepted in the environment, so the stub refuses too: every
# assertion below that finds pool on the PATH is also an assertion
# that the acceptance reached the installer's own process.
if [ "$tool" = pool ] && ! env | grep -q POOL_INSTALL_ACCEPT_EULA=1; then
  echo "interactive confirmation required" >&2
  exit 1
fi
if [ "$tool" = muse ] && ! env | grep -q MUSE_NO_MODIFY_PATH=1; then
  echo "refusing to rewrite shell rc" >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
if [ "$tool" = opencode ]; then
  echo '#!/bin/sh' > "$HOME/.local/bin/$tool"
  echo 'echo 99.0.0' >> "$HOME/.local/bin/$tool"
else
  : > "$HOME/.local/bin/$tool"
fi
chmod +x "$HOME/.local/bin/$tool"
EOF
`,
    );
  }

  run(
    script = this.script,
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    rmSync(path.join(this.root, "fetched"), { force: true });
    const home = path.join(this.root, "home");
    mkdirSync(home, { recursive: true });
    const result = spawnSync("sh", ["-c", script], {
      env: { PATH: `${this.stubs}:${this.root}/usr/local/bin:/usr/bin:/bin`, HOME: home, ...env },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /**
   * Drops a stub so the machine's own tool is used instead. For the
   * handful of assertions that are about a real tool's behaviour rather
   * than about the script calling it; anything that would reach the
   * network stays stubbed.
   */
  unstub(name: string): void {
    rmSync(path.join(this.stubs, name), { force: true });
  }

  /**
   * The same sandbox after a TOOLCHAIN_VERSION bump. A bump renames both
   * versioned paths, which is the whole of what a warm machine notices,
   * so rendering the script against a stamp directory it has never seen
   * is a faithful stand-in for the deploy that follows one. The legacy
   * marker moves too: a bump must not inherit the previous version's
   * word that every CLI was installed.
   */
  runAfterVersionBump(binaries?: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const bumped = agentToolchainScript(binaries)
      .replaceAll(TOOLCHAIN_STAMPS, `${TOOLCHAIN_STAMPS}-next`)
      .replaceAll(TOOLCHAIN_LEGACY_MARKER, `${TOOLCHAIN_LEGACY_MARKER}-next`);
    return this.run(this.relocate(bumped));
  }

  /** The script rendered for one card's agents rather than all ten. */
  runFor(
    binaries: readonly string[],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    return this.run(this.relocate(agentToolchainScript(binaries)), env);
  }

  /** The binaries a run could actually spawn afterwards. */
  published(): string[] {
    return readdirSync(path.join(this.root, "usr/local/bin")).sort();
  }

  fetched(): string[] {
    try {
      return readFileSync(path.join(this.root, "fetched"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Rewrites every absolute path the script writes to so it sits under
   * the test's root. The relocation is only as good as its coverage: a
   * path it misses is a test that writes to the machine it runs on, so
   * anything still absolute afterwards has to be read-only.
   */
  private relocate(script: string): string {
    const moved = script.replaceAll(/(?<![\w/])\/(opt|usr\/local|root|tmp|etc)\//g, `${this.root}/$1/`);
    // /proc/cpuinfo is read, never written: the opencode download reads
    // it to tell an avx2 machine from one that needs the baseline build.
    const allowed = new Set(["/dev/null", "/bin/sh", "/root", "/proc/cpuinfo"]);
    for (const line of moved.split("\n")) {
      // A comment touches nothing, and the script explains itself in
      // terms of the paths and URLs it works with.
      if (line.trim().startsWith("#")) continue;
      for (const found of line.match(/(?<![\w.$/])\/[a-z][\w./-]*/g) ?? []) {
        if (found.startsWith(`${this.root}/`) || allowed.has(found)) continue;
        assert.fail(`the toolchain script writes outside the test's root: ${found}`);
      }
    }
    return moved;
  }

  private stub(name: string, body: string): void {
    this.write(path.join(this.stubs, name), `#!/bin/sh\n${body}\n`);
  }

  private write(file: string, body: string): void {
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
}

function writeCliVersion(file: string, version: string): void {
  assert.ok(existsSync(file), `expected ${file} to exist before rewriting its version`);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  chmodSync(file, 0o755);
}

/** The marker names its version, so a bump reinstalls a warm sandbox. */
test("the marker is versioned", () => {
  assert.match(TOOLCHAIN_STAMPS, /^\/opt\/bento\/toolchain\/v\d+$/);
  assert.match(TOOLCHAIN_LEGACY_MARKER, /^\/opt\/bento\/toolchain-v\d+$/);
  assert.ok(AGENT_TOOLCHAIN_SCRIPT.includes(`STAMPS=${TOOLCHAIN_STAMPS}`));
  assert.ok(AGENT_TOOLCHAIN_SCRIPT.includes(`LEGACY_MARKER=${TOOLCHAIN_LEGACY_MARKER}`));
  // The stamps live beside the marker they replaced rather than on top
  // of it: a warm machine holds that path as a file, and a directory
  // cannot be created over one.
  assert.notEqual(TOOLCHAIN_STAMPS, TOOLCHAIN_LEGACY_MARKER);
  assert.ok(!TOOLCHAIN_STAMPS.startsWith(`${TOOLCHAIN_LEGACY_MARKER}/`));
});

/**
 * pool's installer will not run without a terminal unless the EULA is
 * accepted in its environment, and the acceptance has to reach the
 * installer's own process rather than the script that fetched it. The
 * stub installer above refuses without it, so every assertion that
 * finds pool on the PATH already proves this; asserted here as well
 * because it is a term being accepted on the operator's behalf, and a
 * silent removal should read as a deliberate change.
 */
test("pool's install accepts the EULA, and only pool's", () => {
  const line = AGENT_TOOLCHAIN_SCRIPT.split("\n").find((candidate) => candidate.includes("install_from pool"));
  assert.ok(line, "nothing installs pool");
  assert.match(line, /POOL_INSTALL_ACCEPT_EULA=1 install_from pool/);
  // Scoped to that command: nothing else in the script carries it, and
  // it is never exported for the rest of the run.
  const mentions = AGENT_TOOLCHAIN_SCRIPT.split("\n").filter(
    (candidate) => candidate.includes("POOL_INSTALL_ACCEPT_EULA") && !candidate.trim().startsWith("#"),
  );
  assert.equal(mentions.length, 1);
});

/**
 * The point of the whole change: a card whose pipeline runs two agents
 * waits for two installers, not ten plus a private Node it will never
 * call. Asserted by what the script fetched, because "installed the
 * right things" and "went to the network for the wrong ones" are the
 * same on the PATH afterwards and very different on the clock.
 */
test("a card's own agents are the only ones installed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-scoped-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    const result = sandbox.runFor(["claude", "codex"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.published(), ["claude", "codex"]);
    // Two installers and nothing else. The private Node is the one that
    // matters most here: it is the single largest download in the
    // script, and only pi and dsh ever need it.
    assert.deepEqual(sandbox.fetched().sort(), [
      "https://chatgpt.com/codex/install.sh",
      "https://claude.ai/install.sh",
    ]);
    assert.equal(
      sandbox.fetched().filter((url) => url.includes("nodejs.org")).length,
      0,
      "a card with no npm-only agent downloaded the private Node",
    );

    // And the second stage of that card fetches nothing at all.
    const warm = sandbox.runFor(["claude", "codex"]);
    assert.equal(warm.status, 0, warm.stderr);
    assert.deepEqual(sandbox.fetched(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The case that makes narrowing safe to do at all: an agent can join a
 * pipeline between a card being created and the stage that runs it. The
 * sandbox already exists and has never heard of that CLI, so the
 * provision before that stage has to install it, and only it.
 */
test("an agent added to the pipeline later is installed by the stage that needs it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-added-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.runFor(["claude", "codex"]).stdout), []);

    // Somebody puts an opencode stage on the pipeline. The next
    // provision asks for three.
    const grown = sandbox.runFor(["claude", "codex", "opencode"]);
    assert.equal(grown.status, 0, grown.stderr);
    assert.deepEqual(toolchainMissing(grown.stdout), []);
    assert.deepEqual(sandbox.published(), ["claude", "codex", "opencode"]);
    // Exactly one fetch: the agent that was added. The two already
    // there are not reinstalled, which is what keeps that stage fast.
    assert.equal(sandbox.fetched().length, 1);
    assert.match(sandbox.fetched()[0] ?? "", /releases\/latest\/download\/opencode-linux-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A card that uses pi does pay for the private Node, and a card that
 * does not must not. The npm-only agents are the expensive half of the
 * cold path, so this is the split worth pinning down.
 */
test("the private Node is fetched only for the agents that are published on npm", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-node-scope-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    writeFileSync(path.join(root, "stubs/uname"), "#!/bin/sh\nprintf 'x86_64\\n'\n", { mode: 0o755 });
    // The harness leaves a usable Node already unpacked, which is the
    // warm case. A genuinely cold machine has none.
    rmSync(path.join(root, "opt/bento/node"), { recursive: true, force: true });

    assert.deepEqual(toolchainMissing(sandbox.runFor(["claude"]).stdout), []);
    assert.equal(sandbox.fetched().filter((url) => url.includes("nodejs.org")).length, 0);

    assert.deepEqual(toolchainMissing(sandbox.runFor(["pi"]).stdout), []);
    assert.equal(sandbox.fetched().filter((url) => url.includes("nodejs.org")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The missing line is what provisioning puts in the run's transcript,
 * so it has to name what this card asked for. Reporting the eight CLIs
 * nobody wanted would read as a broken sandbox on every healthy run.
 */
test("the missing line names only the agents this card asked for", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-scoped-missing-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    sandbox.breaks("claude");
    const result = sandbox.runFor(["claude", "codex"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), ["claude"]);
    assert.deepEqual(sandbox.published(), ["codex"]);

    // And the CLI that failed is the only one retried, because a failed
    // install leaves no stamp while codex's stays.
    sandbox.breaks();
    const retry = sandbox.runFor(["claude", "codex"]);
    assert.deepEqual(toolchainMissing(retry.stdout), []);
    assert.deepEqual(sandbox.fetched(), ["https://claude.ai/install.sh"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Warm sprites across the fleet carry the single marker that stamps
 * replaced. Reading it as "nothing is installed" would make the deploy
 * that ships stamps reinstall every CLI on every machine at once, which
 * is the rate limit TOOLCHAIN_VERSION's comment spends forty lines
 * trying not to trigger.
 */
test("a machine holding the marker stamps replaced does not reinstall", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-legacy-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    // Exactly the state a warm sprite is in the moment this ships: every
    // CLI on the PATH, the old whole-set marker on disk, no stamps.
    const stamps = path.join(root, TOOLCHAIN_STAMPS.replace(/^\//, ""));
    const legacy = path.join(root, TOOLCHAIN_LEGACY_MARKER.replace(/^\//, ""));
    rmSync(stamps, { recursive: true, force: true });
    writeFileSync(legacy, "");

    const after = sandbox.runFor(["claude", "codex"]);
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(toolchainMissing(after.stdout), []);
    assert.deepEqual(sandbox.fetched(), [], "a warm machine reinstalled what it already had");

    /**
     * And the marker is still there afterwards.
     *
     * Consuming it would be tidier, and it would also mean that a
     * rollback to the version before stamps, or one older machine still
     * serving during a rolling deploy, saw a sprite with no marker and
     * no stamps it can read, and reinstalled all ten CLIs. Across the
     * fleet at once, which is the fan-out this change exists to avoid.
     */
    // Stated as the predicate the pre-stamp script runs, `[ -f
     // /opt/bento/toolchain-v<N> ]`, because that is the whole of what a
     // rolled-back deploy asks before deciding to reinstall the set.
    assert.equal(
      spawnSync("sh", ["-c", `[ -f ${legacy} ]`]).status,
      0,
      "the marker a rolled-back deploy reads was consumed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/**
 * The git identity moved above the early exit, so it runs on every
 * provision rather than only the cold one. `--add` appends another
 * identical line each time, which on a card with many stages grows
 * /etc/gitconfig without bound.
 */
test("the git identity is written the same way however often it runs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-gitconfig-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    const gitconfig = path.join(root, "etc/gitconfig");
    mkdirSync(path.dirname(gitconfig), { recursive: true });
    /**
     * The real git, pointed at a system config this test owns. Stubbed
     * git would only ever prove what the stub does, and the thing under
     * test is which of git's own flags was used.
     */
    sandbox.unstub("git");

    for (let provision = 0; provision < 3; provision += 1) {
      assert.equal(sandbox.runFor(["claude"], { GIT_CONFIG_SYSTEM: gitconfig }).status, 0);
    }
    const written = readFileSync(gitconfig, "utf8");
    assert.equal(
      written.split("\n").filter((line) => line.includes("directory")).length,
      1,
      `safe.directory was appended once per provision:\n${written}`,
    );
    assert.match(written, /no-reply@usebento\.ai/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A version bump is the one thing that must reinstall a CLI that is
 * present and working, because bumping means the commands Bento builds
 * now want a newer one. Stamping per CLI must not weaken that, and the
 * subtle way it could is a machine that installed only codex at the new
 * version then being asked for claude: the old design would have seen
 * "this version has run here" and skipped it.
 */
test("a bump reinstalls a card's agents one card at a time", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-scoped-bump-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    assert.deepEqual(toolchainMissing(sandbox.run().stdout), []);

    // First card after the bump runs codex, so codex reinstalls.
    const codexCard = sandbox.runAfterVersionBump(["codex"]);
    assert.equal(codexCard.status, 0, codexCard.stderr);
    assert.deepEqual(sandbox.fetched(), ["https://chatgpt.com/codex/install.sh"]);

    // A second card on the same machine runs claude. The bump is still
    // owed to claude even though the version has already installed
    // something here, which is exactly what one shared marker got wrong.
    const claudeCard = sandbox.runAfterVersionBump(["claude"]);
    assert.equal(claudeCard.status, 0, claudeCard.stderr);
    assert.deepEqual(sandbox.fetched(), ["https://claude.ai/install.sh"]);

    // And neither card reinstalls the other's agent on a later stage.
    assert.deepEqual(sandbox.runAfterVersionBump(["codex"]).status, 0);
    assert.deepEqual(sandbox.fetched(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every CLI a profile can name maps to something the script installs. */
test("every agent CLI maps to a binary the toolchain installs", () => {
  for (const [cli, binary] of Object.entries(AGENT_CLI_BINARIES)) {
    if (binary === null) {
      // The in-process test agent spawns nothing, so it installs nothing.
      assert.equal(cli, "fake");
      continue;
    }
    assert.ok(
      (AGENT_BINARIES as readonly string[]).includes(binary),
      `${cli} maps to ${binary}, which the toolchain does not install`,
    );
  }
});

test("a pipeline's CLIs become the binaries to install, deduplicated and ordered", () => {
  assert.deepEqual(toolchainBinaries(["claude-code", "codex"]), ["claude", "codex"]);
  // Order follows AGENT_BINARIES rather than the caller, so the same
  // pipeline always renders the same script and a warm sandbox is not
  // re-probed because two stages were listed the other way round.
  assert.deepEqual(toolchainBinaries(["codex", "claude-code"]), ["claude", "codex"]);
  assert.deepEqual(toolchainBinaries(["cursor", "cursor", "antigravity"]), ["agy", "cursor-agent"]);
  // The fake agent needs no sandbox binary, and asking for it alone
  // must not render a `for tool in ; do` that no shell will parse.
  assert.deepEqual(toolchainBinaries(["fake"]), []);
  assert.equal(spawnSync("sh", ["-n", "-c", agentToolchainScript([])]).status, 0);
  assert.equal(spawnSync("sh", ["-n", "-c", toolchainPresenceProbe([])]).status, 0);
});

/**
 * Parsing is not running. A card that asks for no agent still gets a
 * sandbox that can clone, because git is the repository's business
 * rather than any agent's and provisioning clones straight afterwards.
 */
test("a card that asks for no agent still gets a usable sandbox", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-empty-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    const result = sandbox.runFor([]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), []);
    assert.deepEqual(sandbox.fetched(), [], "a card with no agents went to the network");
    assert.deepEqual(sandbox.published(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the presence probe asks about this card's agents and touches no installer", () => {
  const probe = toolchainPresenceProbe(["claude", "codex"]);
  assert.match(probe, /for tool in claude codex; do/);
  assert.ok(probe.includes(TOOLCHAIN_STAMPS));
  assert.doesNotMatch(probe, /curl|apt-get|install/);
  assert.equal(spawnSync("sh", ["-n", "-c", probe]).status, 0);
});

/**
 * The probe decides one thing: whether the run's transcript promises a
 * minutes-long wait. Reading only stamps would tell every warm sprite in
 * the fleet it was about to install, right before installing nothing.
 */
test("the presence probe reads the pre-stamp marker too", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-probe-"));
  try {
    const stamps = path.join(root, TOOLCHAIN_STAMPS.replace(/^\//, ""));
    const legacy = path.join(root, TOOLCHAIN_LEGACY_MARKER.replace(/^\//, ""));
    const probe = toolchainPresenceProbe(["claude", "codex"])
      .replaceAll(TOOLCHAIN_STAMPS, stamps)
      .replaceAll(TOOLCHAIN_LEGACY_MARKER, legacy);
    const ask = () => spawnSync("sh", ["-c", probe], { encoding: "utf8" }).stdout.trim();

    assert.equal(ask(), "tools-absent", "a machine with nothing on it");

    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, "");
    assert.equal(ask(), "tools-present", "a warm sprite from before stamps");

    rmSync(legacy);
    mkdirSync(stamps, { recursive: true });
    writeFileSync(path.join(stamps, "claude"), "");
    assert.equal(ask(), "tools-absent", "one of the two is stamped, the other is not");
    writeFileSync(path.join(stamps, "codex"), "");
    assert.equal(ask(), "tools-present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
