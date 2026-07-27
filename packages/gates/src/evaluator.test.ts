import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckSummary, GitHubClient } from "@bento/github";
import type { ExecChunk, SandboxHandle } from "@bento/sandbox";
import { evaluateGate, type GateContext } from "./evaluator.js";

const handle: SandboxHandle = { externalId: "x", provider: "local-process", workdir: "/workspace" };

function fakeSandbox(exitCode: number, stderr = ""): GateContext["sandbox"] {
  return {
    handle,
    async *exec(): AsyncIterable<ExecChunk> {
      if (stderr) yield { kind: "stderr", data: stderr };
      yield { kind: "exit", exitCode };
    },
  };
}

function fakeGitHub(unresolved: number, checks = { total: 1, pending: 0, failed: 0 }): GitHubClient {
  return {
    async reviewThreads() {
      return { total: unresolved + 1, unresolved };
    },
    async checks() {
      return checks;
    },
  };
}

/** One pull request, which is what most of these criteria need. */
const prs = [{ owner: "acme", repo: "widgets", prNumber: 1 }];

/** Answers differently per repository, which one summary cannot. */
function perRepoGitHub(byRepo: Record<string, { unresolved?: number; checks?: CheckSummary }>): GitHubClient {
  return {
    async reviewThreads(ref) {
      const unresolved = byRepo[ref.repo]?.unresolved ?? 0;
      return { total: unresolved + 1, unresolved };
    },
    async checks(ref) {
      return byRepo[ref.repo]?.checks ?? { total: 1, pending: 0, failed: 0 };
    },
  };
}

/**
 * A card spanning two repositories has a pull request in each and is
 * only finished when both are. Reading only the first would call the
 * card done while the other still had unresolved comments or red checks.
 */
test("pr criteria span every repository the card touched", async () => {
  const spanning = [
    { owner: "acme", repo: "web", prNumber: 1 },
    { owner: "acme", repo: "api", prNumber: 2 },
  ];

  const comments = await evaluateGate([{ type: "pr_comments_resolved" }], {
    manuallyApproved: false,
    prs: spanning,
    // The first is clean; only the second is holding the card.
    github: perRepoGitHub({ web: { unresolved: 0 }, api: { unresolved: 3 } }),
  });
  assert.equal(comments.passed, false);
  assert.match(comments.outcomes[0]?.result.detail ?? "", /3 unresolved review comments in api #2/);

  const checks = await evaluateGate([{ type: "checks_pass" }], {
    manuallyApproved: false,
    prs: spanning,
    github: perRepoGitHub({
      web: { checks: { total: 2, pending: 1, failed: 0 } },
      api: { checks: { total: 1, pending: 0, failed: 1 } },
    }),
  });
  // Failed beats pending: the card is not advancing either way, and
  // waiting on the other repository only delays saying so.
  assert.equal(checks.outcomes[0]?.result.status, "failed");
  assert.match(checks.outcomes[0]?.result.detail ?? "", /1 checks failed in api #2/);

  const allGreen = await evaluateGate([{ type: "checks_pass" }, { type: "pr_comments_resolved" }], {
    manuallyApproved: false,
    prs: spanning,
    github: perRepoGitHub({}),
  });
  assert.equal(allGreen.passed, true);
});

test("manual gate waits for approval then passes", async () => {
  const waiting = await evaluateGate([{ type: "manual" }], { manuallyApproved: false });
  assert.equal(waiting.passed, false);
  assert.equal(waiting.outcomes[0]?.result.status, "pending");

  const approved = await evaluateGate([{ type: "manual" }], { manuallyApproved: true });
  assert.equal(approved.passed, true);
});

test("pr_comments_resolved fails while threads are unresolved", async () => {
  const blocked = await evaluateGate([{ type: "pr_comments_resolved" }], {
    manuallyApproved: false,
    prs,
    github: fakeGitHub(2),
  });
  assert.equal(blocked.passed, false);
  assert.equal(blocked.outcomes[0]?.result.status, "failed");
  assert.match(blocked.outcomes[0]?.result.detail ?? "", /2 unresolved review comments/);

  const clear = await evaluateGate([{ type: "pr_comments_resolved" }], {
    manuallyApproved: false,
    prs,
    github: fakeGitHub(0),
  });
  assert.equal(clear.passed, true);
});

test("pr criteria stay pending without a linked PR", async () => {
  const outcome = await evaluateGate([{ type: "pr_comments_resolved" }, { type: "checks_pass" }], {
    manuallyApproved: false,
  });
  assert.equal(outcome.passed, false);
  assert.deepEqual(
    outcome.outcomes.map((o) => o.result.status),
    ["pending", "pending"],
  );
});

test("checks_pass distinguishes pending, failed, and empty", async () => {
  const running = await evaluateGate([{ type: "checks_pass" }], {
    manuallyApproved: false,
    prs,
    github: fakeGitHub(0, { total: 3, pending: 1, failed: 0 }),
  });
  assert.equal(running.outcomes[0]?.result.status, "pending");

  const failing = await evaluateGate([{ type: "checks_pass" }], {
    manuallyApproved: false,
    prs,
    github: fakeGitHub(0, { total: 3, pending: 0, failed: 2 }),
  });
  assert.equal(failing.outcomes[0]?.result.status, "failed");

  const none = await evaluateGate([{ type: "checks_pass" }], {
    manuallyApproved: false,
    prs,
    github: fakeGitHub(0, { total: 0, pending: 0, failed: 0 }),
  });
  assert.equal(none.passed, true);
  assert.match(none.outcomes[0]?.result.detail ?? "", /No checks configured/);
});

test("command gate reflects exit code and surfaces output tail", async () => {
  const ok = await evaluateGate([{ type: "command", cmd: "pnpm test", timeoutSec: 60 }], {
    manuallyApproved: false,
    sandbox: fakeSandbox(0),
  });
  assert.equal(ok.passed, true);

  const bad = await evaluateGate([{ type: "command", cmd: "pnpm test", timeoutSec: 60 }], {
    manuallyApproved: false,
    sandbox: fakeSandbox(1, "2 tests failed\n"),
  });
  assert.equal(bad.passed, false);
  assert.match(bad.outcomes[0]?.result.detail ?? "", /exited 1: 2 tests failed/);
});

test("all criteria are evaluated even after one fails", async () => {
  const outcome = await evaluateGate(
    [
      { type: "command", cmd: "false", timeoutSec: 60 },
      { type: "pr_comments_resolved" },
    ],
    { manuallyApproved: false, prs, github: fakeGitHub(0), sandbox: fakeSandbox(1) },
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.outcomes.length, 2);
  assert.equal(outcome.outcomes[1]?.result.status, "passed");
});

test("an evaluator that throws fails its criterion without killing the gate", async () => {
  const exploding: GitHubClient = {
    async reviewThreads() {
      throw new Error("rate limited");
    },
    async checks() {
      return { total: 0, pending: 0, failed: 0 };
    },
  };
  const outcome = await evaluateGate([{ type: "pr_comments_resolved" }, { type: "checks_pass" }], {
    manuallyApproved: false,
    prs,
    github: exploding,
  });
  assert.equal(outcome.outcomes[0]?.result.status, "failed");
  assert.match(outcome.outcomes[0]?.result.detail ?? "", /rate limited/);
  assert.equal(outcome.outcomes[1]?.result.status, "passed");
});

test("an empty criteria list never auto-advances", async () => {
  const outcome = await evaluateGate([], { manuallyApproved: true });
  assert.equal(outcome.passed, false);
});
