import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_BINARIES, AGENT_TOOLCHAIN_SCRIPT } from "./agent-toolchain.js";

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
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /git curl ca-certificates/);
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

test("the script exits early once its marker is there", () => {
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /\[ -f "\$MARKER" \] && exit 0/);
  assert.match(AGENT_TOOLCHAIN_SCRIPT, /touch "\$MARKER"/);
});
