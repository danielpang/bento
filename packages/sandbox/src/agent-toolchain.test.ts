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
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "pi"]);
    // Not once and given up on: a blip passes within seconds.
    assert.equal(sandbox.fetched().filter((url) => url === "https://opencode.ai/install").length, 3);

    // Second provision, with both reachable again. Only the CLI that is
    // missing is fetched; the four that are there are not reinstalled,
    // which is what keeps a warm sandbox warm.
    sandbox.breaks();
    const second = sandbox.run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(toolchainMissing(second.stdout), []);
    assert.deepEqual(sandbox.fetched(), ["https://opencode.ai/install"]);
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "opencode", "pi"]);

    // Third provision, with everything in place: no network at all.
    const third = sandbox.run();
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(sandbox.fetched(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The failure that actually happened, twice.
 *
 * opencode's installer asks api.github.com which release is latest and
 * exits without installing when that call fails. It fails for an hour
 * at a time, because that is the window an address gets sixty
 * unauthenticated requests in, and a pool of sprites shares one
 * address. No retry this script could reasonably wait out covers an
 * hour, so the answer is not to need the API: the release is served
 * from /releases/latest/download without it.
 */
test("opencode installs from its release when the installer cannot reach the GitHub API", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-fallback-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    sandbox.breaks("opencode");
    const result = sandbox.run();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), [], "opencode should have come from the release");
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "opencode", "pi"]);
    assert.ok(
      sandbox.fetched().some((url) => url.includes("releases/latest/download/opencode-linux-")),
      `the release was never fetched: ${sandbox.fetched().join(" ")}`,
    );
    // The vendor's installer is still tried first, so anything else it
    // does keeps happening on the days it works.
    assert.ok(sandbox.fetched().some((url) => url === "https://opencode.ai/install"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Both routes down is still reported, not silently swallowed. */
test("opencode is reported missing when the installer and the release are both unreachable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bento-toolchain-bothdown-"));
  try {
    const sandbox = new ToolchainSandbox(root);
    sandbox.breaks("opencode", "opencode-release");
    const result = sandbox.run();

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(toolchainMissing(result.stdout), ["opencode"]);
    assert.match(result.stderr, /opencode release download failed/);
    // And the other four are unharmed.
    assert.deepEqual(sandbox.published(), ["claude", "codex", "cursor-agent", "pi"]);
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
    this.script = AGENT_TOOLCHAIN_SCRIPT.replaceAll(
      /(?<![\w/])\/(opt|usr\/local|root|tmp|etc)\//g,
      `${root}/$1/`,
    );

    /**
     * The relocation is only as good as its coverage: a path it misses
     * is a test that writes to the machine it runs on. Anything still
     * absolute has to be either inside the root or read-only.
     */
    // /proc/cpuinfo is read, never written: the opencode fallback reads
    // it to tell an avx2 machine from one that needs the baseline build.
    const allowed = new Set(["/dev/null", "/bin/sh", "/root", "/proc/cpuinfo"]);
    for (const line of this.script.split("\n")) {
      // A comment touches nothing, and the script explains itself in
      // terms of the paths and URLs it works with.
      if (line.trim().startsWith("#")) continue;
      for (const found of line.match(/(?<![\w.$/])\/[a-z][\w./-]*/g) ?? []) {
        if (found.startsWith(`${root}/`) || allowed.has(found)) continue;
        assert.fail(`the toolchain script writes outside the test's root: ${found}`);
      }
    }

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

    // pi's private Node, already unpacked, so the npm stub is all the
    // rest of that branch needs.
    const nodeBin = path.join(root, "opt/bento/node/bin");
    mkdirSync(nodeBin, { recursive: true });
    this.write(path.join(nodeBin, "node"), "#!/bin/sh\nexit 0\n");
    this.write(
      path.join(nodeBin, "npm"),
      `#!/bin/sh\nmkdir -p ${root}/opt/bento/pi/bin\n: > ${root}/opt/bento/pi/bin/pi\nchmod +x ${root}/opt/bento/pi/bin/pi\n`,
    );
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
  *) exit 22 ;;
esac
for broken in ${broken.join(" ")}; do
  if [ "$broken" = "$tool" ]; then exit 22; fi
done
cat > "$out" <<EOF
#!/bin/sh
mkdir -p "$HOME/.local/bin"
: > "$HOME/.local/bin/$tool"
chmod +x "$HOME/.local/bin/$tool"
EOF
`,
    );
  }

  run(): { status: number | null; stdout: string; stderr: string } {
    rmSync(path.join(this.root, "fetched"), { force: true });
    const home = path.join(this.root, "home");
    mkdirSync(home, { recursive: true });
    const result = spawnSync("sh", ["-c", this.script], {
      env: { PATH: `${this.stubs}:${this.root}/usr/local/bin:/usr/bin:/bin`, HOME: home },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
