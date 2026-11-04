import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reportInstall, type InstallReport } from "./install-report.js";

/** A server that records what it was sent and answers with `status`. */
function server(status = 204) {
  const sent: InstallReport[] = [];
  const state = { status };
  const fake: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: state.status });
  };
  return { sent, state, fetch: fake };
}

async function profile() {
  return mkdtemp(path.join(os.tmpdir(), "bento-install-report-"));
}

test("a new profile reports an install once, then each version change as an update", async () => {
  const directory = await profile();
  try {
    const remote = server();
    const launch = (version: string) => reportInstall({ directory, version, arch: "arm64", osVersion: "15.1.0", configured: false, fetch: remote.fetch });

    assert.equal((await launch("0.4.2"))?.event, "installed");
    assert.equal(await launch("0.4.2"), null, "a relaunch on the same version says nothing");
    const update = await launch("0.4.3");
    assert.equal(update?.event, "updated");
    assert.equal(update?.previous_version, "0.4.2");

    assert.equal(remote.sent.length, 2);
    assert.equal(remote.sent[0]!.install_id, remote.sent[1]!.install_id, "one install, one id");
    assert.match(remote.sent[0]!.install_id, /^[0-9a-f-]{36}$/);
    assert.equal(remote.sent[0]!.os_version, "15.1.0");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a profile with saved connections from before reports an update, not an install", async () => {
  const directory = await profile();
  try {
    const remote = server();
    const report = await reportInstall({ directory, version: "0.4.3", arch: "x64", configured: true, fetch: remote.fetch });
    assert.equal(report?.event, "updated");
    assert.equal(report?.previous_version, "unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a report that could not go is sent on the next launch, still as the install it was", async () => {
  const directory = await profile();
  try {
    const remote = server(503);
    assert.equal(await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: false, fetch: remote.fetch }), null);
    const notDeployed = server(404);
    assert.equal(await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: false, fetch: notDeployed.fetch }), null);
    const offline: typeof fetch = async () => { throw new TypeError("fetch failed"); };
    assert.equal(await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: false, fetch: offline }), null);

    // By now the person has connected, which must not turn the install into an update.
    remote.state.status = 204;
    const report = await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: true, fetch: remote.fetch });
    assert.equal(report?.event, "installed");
    assert.equal(await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: true, fetch: remote.fetch }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a refusal is not retried every launch, and a damaged state file starts over", async () => {
  const directory = await profile();
  try {
    const remote = server(400);
    await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: false, fetch: remote.fetch });
    await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: false, fetch: remote.fetch });
    assert.equal(remote.sent.length, 1);

    await writeFile(path.join(directory, "install.json"), "{not json");
    remote.state.status = 204;
    assert.equal((await reportInstall({ directory, version: "0.4.2", arch: "arm64", configured: false, fetch: remote.fetch }))?.event, "installed");
    const saved = JSON.parse(await readFile(path.join(directory, "install.json"), "utf8"));
    assert.equal(saved.reportedVersion, "0.4.2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
