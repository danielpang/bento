import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeAdapter, codexAdapter, opencodeAdapter, type AgentAdapter } from "@bento/agents";
import type { SandboxDriver } from "@bento/sandbox";
import { liveSessionFor } from "./run-executor.js";
import type { RunSubject } from "./run-subject.js";

/**
 * Which runs hold a live session: every run of a tool that has one, on
 * a driver that can attach stdin. And a server that reattaches after a
 * restart must speak to the process the way its first life started it,
 * whatever it would decide now.
 */
function subject(liveSession: boolean | null): RunSubject {
  return { run: { startedBy: "user-1", liveSession }, project: { ownerId: "owner-1" } } as unknown as RunSubject;
}

const stdin = { supportsStdin: true } as SandboxDriver;
const noStdin = { supportsStdin: false } as SandboxDriver;
const commandInput = { prompt: "p", model: "m", cwd: "/w" };

function choose(adapter: AgentAdapter, opts: { recorded?: boolean | null; attach?: boolean; driver?: SandboxDriver; extraArgs?: string[] } = {}) {
  return liveSessionFor({
    adapter,
    driver: opts.driver ?? stdin,
    subject: subject(opts.recorded ?? null),
    commandInput: { ...commandInput, ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}) },
    attach: opts.attach ?? false,
  });
}

test("every run of a tool with a live mode goes live, on a driver that can attach stdin", () => {
  assert.equal(choose(claudeCodeAdapter), claudeCodeAdapter.live);
  assert.equal(choose(codexAdapter), codexAdapter.live);
  assert.equal(choose(opencodeAdapter), opencodeAdapter.live);
  assert.equal(choose(claudeCodeAdapter, { driver: noStdin }), null, "a driver without stdin cannot hold one");
  assert.equal(choose(codexAdapter, { extraArgs: ["--search"] }), null, "a profile flag only codex exec takes keeps codex exec");
});

test("a reattach speaks to the process the way its first life started it", () => {
  assert.equal(choose(codexAdapter, { attach: true, recorded: true }), codexAdapter.live);
  assert.equal(choose(claudeCodeAdapter, { attach: true, recorded: false }), null, "started one-shot: never fed JSON on reattach");
});

test("a reattach to a run from before the record goes live only on a tool that was live then", () => {
  assert.equal(choose(claudeCodeAdapter, { attach: true, recorded: null }), claudeCodeAdapter.live);
  assert.equal(choose(codexAdapter, { attach: true, recorded: null }), null, "a codex run that old was codex exec");
  assert.equal(choose(opencodeAdapter, { attach: true, recorded: null }), null, "an opencode run that old was opencode run");
});
