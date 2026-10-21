import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter, codexAdapter, type AgentAdapter } from "@bento/agents";
import type { SandboxDriver } from "@bento/sandbox";
import type { AppContext } from "../context.js";
import { liveSessionFor } from "./run-executor.js";
import type { RunSubject } from "./run-subject.js";

/**
 * Which runs hold a live session. Codex's (and opencode's) live mode is
 * beta, so it is a beta tester's run that goes live; and a server that
 * reattaches after a restart must speak to the process the way its
 * first life started it, whatever the flag says now.
 *
 * isBetaRun answers without a database when no feature flags are
 * configured: true in local mode, false in multi mode. That is all these
 * cases need from the context.
 */
function ctx(mode: "local" | "multi"): AppContext {
  return { env: { BENTO_MODE: mode }, featureFlags: undefined } as unknown as AppContext;
}

function subject(liveSession: boolean | null): RunSubject {
  return {
    run: { startedBy: "user-1", liveSession },
    project: { ownerId: "owner-1" },
  } as unknown as RunSubject;
}

const stdin = { supportsStdin: true } as SandboxDriver;
const noStdin = { supportsStdin: false } as SandboxDriver;
const commandInput = { prompt: "p", model: "m", cwd: "/w" };

async function choose(adapter: AgentAdapter, opts: { mode?: "local" | "multi"; recorded?: boolean | null; attach?: boolean; driver?: SandboxDriver }) {
  return liveSessionFor(ctx(opts.mode ?? "multi"), {
    adapter,
    driver: opts.driver ?? stdin,
    subject: subject(opts.recorded ?? null),
    commandInput,
    attach: opts.attach ?? false,
  });
}

test("a tool whose live mode is not beta goes live for everyone, as before", async () => {
  assert.equal(await choose(claudeCodeAdapter, { mode: "multi" }), claudeCodeAdapter.live);
  assert.equal(await choose(claudeCodeAdapter, { driver: noStdin }), null, "a driver without stdin cannot hold one");
});

test("a beta live mode goes live only for a beta tester's run", async () => {
  assert.equal(await choose(codexAdapter, { mode: "multi" }), null, "not a beta tester: codex exec, as before");
  assert.equal(await choose(codexAdapter, { mode: "local" }), codexAdapter.live, "local mode is always beta");
});

test("a reattach speaks to the process the way its first life started it", async () => {
  assert.equal(await choose(codexAdapter, { mode: "multi", attach: true, recorded: true }), codexAdapter.live,
    "started live by a tester who is no longer one: still live");
  assert.equal(await choose(claudeCodeAdapter, { attach: true, recorded: false }), null,
    "started one-shot: never fed JSON on reattach");
});

test("a reattach to a run from before the record goes live only on a tool that was never beta", async () => {
  assert.equal(await choose(claudeCodeAdapter, { attach: true, recorded: null }), claudeCodeAdapter.live);
  assert.equal(await choose(codexAdapter, { mode: "local", attach: true, recorded: null }), null,
    "a codex run that old was codex exec");
});
