import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_BINARIES,
  AGENT_TOOLCHAIN_SCRIPT,
  TOOLCHAIN_MARKER,
  TOOLCHAIN_VERSION,
  toolchainMissing,
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
    assert.equal(
      readFileSync(path.join(root, "dsh-runs"), "utf8").trim(),
      "deepseek-v4-pro|danger-full-access|1|--profile headless --dump-config",
    );

    const image = await readFile(dockerfile, "utf8");
    for (const required of [
      "BENTO_NODE_VERSION=22.22.2",
      "@deepseek-ai/dsh@0.1.1-rc.2",
      "exec /opt/bento/dsh/bin/dsh",
      "for tool in claude codex cursor-agent dsh opencode pi pool",
      "model: !!js process.env.DSH_MODEL",
      "provider: deepseek-official",
      "DSH_PERMISSION_MODE=danger-full-access",
      "DSH_TELEMETRY_DISABLED=1",
      "dsh --profile headless --dump-config",
    ]) {
      assert.ok(image.includes(required), `the Docker image is missing ${required}`);
    }
    assert.doesNotMatch(image, /ENV PATH=.*\/opt\/bento\/node/);
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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "pi", "pool"]);
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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "opencode", "pi", "pool"]);

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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "opencode", "pi", "pool"]);
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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "opencode", "pi", "pool"]);
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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "opencode", "pi", "pool"]);
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
    for (const installer of ["claude", "codex", "opencode", "cursor", "poolside"]) {
      assert.ok(
        sandbox.fetched().some((url) => url.includes(installer)),
        `a bump did not reinstall ${installer}: ${sandbox.fetched().join(" ")}`,
      );
    }
    assert.deepEqual(toolchainMissing(bumped.stdout), ["opencode"]);
    // The four that did install are still usable. A bump that fails
    // halfway must not take the working CLIs down with it.
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "pi", "pool"]);

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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "opencode", "pi", "pool"]);
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
 * Catching that would mean knowing each CLI's version and how to ask
 * for it, which is a bigger thing than this script. What it does
 * guarantee is the part that matters for a run: a CLI is either there
 * or reported.
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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "opencode", "pi", "pool"]);
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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "dsh", "pi", "pool"]);
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
    writeFileSync(path.join(fixtures, "opencode"), "#!/bin/sh\n");
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
package=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; shift 2; continue; fi
  package=$1
  shift
done
case "$package" in
  @deepseek-ai/dsh@*) binary=dsh ;;
  @earendil-works/pi-coding-agent) binary=pi ;;
  *) exit 1 ;;
esac
mkdir -p "$prefix/bin"
cat > "$prefix/bin/$binary" <<'EOF'
#!/bin/sh
printf '%s\\n' "\${DSH_MODEL:-}|\${DSH_PERMISSION_MODE:-}|\${DSH_TELEMETRY_DISABLED:-}|\$*" >> ${root}/dsh-runs
EOF
chmod +x "$prefix/bin/$binary"
printf '%s\\n' "$package" >> ${root}/npm-installs
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
  *poolside*) tool=pool ;;
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
mkdir -p "$HOME/.local/bin"
: > "$HOME/.local/bin/$tool"
chmod +x "$HOME/.local/bin/$tool"
EOF
`,
    );
  }

  run(script = this.script): { status: number | null; stdout: string; stderr: string } {
    rmSync(path.join(this.root, "fetched"), { force: true });
    const home = path.join(this.root, "home");
    mkdirSync(home, { recursive: true });
    const result = spawnSync("sh", ["-c", script], {
      env: { PATH: `${this.stubs}:${this.root}/usr/local/bin:/usr/bin:/bin`, HOME: home },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  /**
   * The same sandbox after a TOOLCHAIN_VERSION bump. A bump renames the
   * marker, which is the whole of what a warm machine notices, so
   * rendering the script against a marker it has never seen is a
   * faithful stand-in for the deploy that follows one.
   */
  runAfterVersionBump(): { status: number | null; stdout: string; stderr: string } {
    return this.run(this.relocate(AGENT_TOOLCHAIN_SCRIPT.replaceAll(TOOLCHAIN_MARKER, `${TOOLCHAIN_MARKER}-next`)));
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

/** The marker names its version, so a bump reinstalls a warm sandbox. */
test("the marker is versioned", () => {
  assert.match(TOOLCHAIN_MARKER, /^\/opt\/bento\/toolchain-v\d+$/);
  assert.ok(AGENT_TOOLCHAIN_SCRIPT.includes(`MARKER=${TOOLCHAIN_MARKER}`));
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
