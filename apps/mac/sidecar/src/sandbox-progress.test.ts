import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, parseBuildStep, sandboxProgressMessage } from "./sandbox-progress.js";

test("a build step becomes a readable stage with its position", () => {
  assert.deepEqual(parseBuildStep({ stream: "Step 3/9 : RUN set -eu; fetch_run() { ..." }), {
    step: 3, total: 9, label: "Installing the agent tools (Claude Code, Codex, and others)",
  });
  assert.equal(parseBuildStep({ stream: "Step 1/9 : FROM ubuntu:24.04\n" })?.label, "Downloading the base system");
  assert.equal(parseBuildStep({ stream: " ---> Running in 1234" }), null);
  assert.equal(parseBuildStep({}), null);
});

test("the message says how long the build has been running", () => {
  assert.equal(formatElapsed(42_000), "42s");
  assert.equal(formatElapsed(125_000), "2m 05s");
  assert.equal(
    sandboxProgressMessage({ step: 2, total: 9, label: "Installing git and search tools" }, 65_000),
    "Installing git and search tools (step 2 of 9). First launch only, this can take several minutes. 1m 05s so far.",
  );
  assert.match(sandboxProgressMessage(null, 0), /^Preparing the agent sandbox\./);
});
