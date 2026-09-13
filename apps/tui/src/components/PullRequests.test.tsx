import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import { render } from "ink-testing-library";
import type { BentoClient, FeaturePullRequestRecord, Stage } from "@bento/api-client";
import { MouseProvider } from "../mouse.js";
import { PullRequests, pullRequestRows } from "./PullRequests.js";
const history: FeaturePullRequestRecord[] = [
  {
    name: "api",
    number: 12,
    url: "https://github.com/acme/api/pull/12",
    branch: "feature/new",
    current: true,
  },
  {
    name: "api",
    number: 11,
    url: "https://github.com/acme/api/pull/11",
    branch: "feature/old",
    current: false,
  },
  {
    name: "web",
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    branch: "feature/new",
    current: true,
  },
];
const rows = () =>
  pullRequestRows(
    history,
    history.map((pr) => ({ ...pr, state: pr.number === 11 ? "merged" : "open" })),
    history.map((pr) => ({ ...pr, state: pr.name === "api" ? "conflicted" : "clean" })),
    history.map((pr) => ({ ...pr, state: pr.name === "api" ? "failed" : "passed" })),
  );
const frame = (ui: ReturnType<typeof render>) =>
  ui.frames
    .map(stripVTControlCharacters)
    .filter((frame) => frame.trim())
    .at(-1) ?? "";
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
async function ready(ui: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 30; i++) {
    if (frame(ui)?.includes(text)) return;
    await pause();
  }
  throw Error(frame(ui));
}

test("PR rows retain several branches per repo and distinguish equal numbers across repos", () => {
  const result = rows();
  assert.equal(result.length, 3);
  assert.equal(result[0]!.merge, "❌ Merge conflicts");
  assert.equal(result[0]!.ci, "❌ CI checks failing");
  assert.equal(result[1]!.name, "web");
  assert.equal(result[1]!.merge, "✅ No merge conflicts");
  assert.equal(result[1]!.ci, "✅ CI checks passed");
  assert.equal(result[2]!.status, "Merged");
  assert.equal(result[2]!.merge, "");
  assert.equal(result[2]!.ci, "");
  const unknown = pullRequestRows(history, [], [], []);
  assert.equal(unknown[0]!.merge, "❓ Merge status unknown");
  assert.equal(unknown[0]!.ci, "❓ CI status unknown");
});

test("PR inspector shows branch history, conflicts and CI, then returns to all PRs", async () => {
  const ui = render(
    <PullRequests
      client={{} as BentoClient}
      featureId="card"
      rows={rows()}
      error=""
      initialUrl={history[0]!.url}
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
  try {
    await ready(ui, "❌ Merge conflicts");
    assert.match(frame(ui)!, /CI checks failing/);
    assert.match(frame(ui)!, /feature\/new/);
    ui.stdin.write("\x1b");
    await ready(ui, "Create or update PRs");
    assert.match(frame(ui)!, /api #11/);
    assert.match(frame(ui)!, /web #12/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("publication uses Bento's API without asking the agent and reports partial failures", async () => {
  const requests: string[] = [];
  const client = {
    publishFeature: async (id: string) => {
      requests.push(id);
      return {
        published: [{ name: "api", url: history[0]!.url }],
        failures: [{ name: "web", reason: "GitHub access denied" }],
      };
    },
  } as unknown as BentoClient;
  const ui = render(
    <PullRequests
      client={client}
      featureId="card"
      rows={[]}
      error=""
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
  try {
    await pause();
    ui.stdin.write("Create or update PRs");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "GitHub access denied");
    assert.deepEqual(requests, ["card"]);
    assert.match(frame(ui)!, /api\/pull\/12/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("automatic PR control updates only the chosen stage and does not publish existing commits", async () => {
  const changes: unknown[] = [];
  const client = {
    updateStage: async (id: string, change: unknown) => {
      changes.push({ id, change });
    },
  } as unknown as BentoClient;
  const ui = render(
    <PullRequests
      client={client}
      featureId="card"
      rows={[]}
      stage={{ id: "implementation", name: "Implementation", createPr: false } as Stage}
      error=""
      onClose={() => {}}
      onChanged={() => {}}
    />,
  );
  try {
    await pause();
    ui.stdin.write("Automatic PR");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Implementation: On");
    assert.deepEqual(changes, [{ id: "implementation", change: { createPr: true } }]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

async function click(ui: ReturnType<typeof render>, label: string) {
  await pause();
  const lines = frame(ui)!.split("\n");
  const y = lines.findIndex((line) => line.includes(label));
  assert.ok(y >= 0, `Missing ${label}: ${frame(ui)}`);
  const x = lines[y]!.indexOf(label);
  ui.stdin.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
  await pause();
}

for (const [label, method] of [
  ["Fix CI tests", "fixCiTests"],
  ["Fix merge conflicts", "resolveConflicts"],
] as const) {
  test(`${label} starts the existing repair flow once and returns to the conversation`, async () => {
    const requests: string[] = [];
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const client = {
      [method]: (id: string) => {
        requests.push(id);
        return pending;
      },
    } as unknown as BentoClient;
    let changed = 0,
      opened = 0;
    const ui = render(
      <MouseProvider enabled>
        <PullRequests
          client={client}
          featureId="card"
          rows={rows()}
          error=""
          initialUrl={history[0]!.url}
          onClose={() => {}}
          onChanged={() => changed++}
          onRunStarted={() => opened++}
        />
      </MouseProvider>,
    );
    try {
      await ready(ui, label);
      await click(ui, `[${label}]`);
      await ready(ui, "Starting repair…");
      await click(ui, `[${label}]`);
      assert.deepEqual(requests, ["card"]);
      assert.equal(opened, 0);
      finish({ id: "repair-run" });
      await ready(ui, "repair started");
      assert.equal(changed, 1);
      assert.equal(opened, 1);
    } finally {
      finish({ id: "repair-run" });
      ui.unmount();
      ui.cleanup();
    }
  });
}

test("repair errors stay visible on the PR and can be retried", async () => {
  let calls = 0;
  const client = {
    fixCiTests: async () => {
      if (++calls === 1) throw new Error("GitHub status is unavailable. Try again.");
      return { id: "repair-run" };
    },
  } as unknown as BentoClient;
  const ui = render(
    <MouseProvider enabled>
      <PullRequests
        client={client}
        featureId="card"
        rows={rows()}
        error=""
        initialUrl={history[0]!.url}
        onClose={() => {}}
        onChanged={() => {}}
      />
    </MouseProvider>,
  );
  try {
    await ready(ui, "Fix CI tests");
    await click(ui, "[Fix CI tests]");
    await ready(ui, "GitHub status is unavailable");
    assert.match(frame(ui)!, /api #12/);
    await click(ui, "[Fix CI tests]");
    await ready(ui, "CI repair started");
    assert.equal(calls, 2);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("repair controls are unavailable for previous PRs, finished cards and active runs", async () => {
  let calls = 0;
  const client = {
    fixCiTests: async () => {
      calls++;
    },
    resolveConflicts: async () => {
      calls++;
    },
  } as unknown as BentoClient;
  for (const mode of ["previous", "closed", "finished", "active", "healthy"] as const) {
    const pr = {
      ...rows()[0]!,
      ...(mode === "previous" ? { current: false } : {}),
      ...(mode === "closed" ? { status: "Closed", state: "closed" as const } : {}),
      ...(mode === "healthy"
        ? {
            merge: "✅ No merge conflicts",
            ci: "✅ CI checks passed",
            mergeState: "clean" as const,
            ciState: "passed" as const,
          }
        : {}),
    };
    const ui = render(
      <MouseProvider enabled>
        <PullRequests
          client={client}
          featureId="card"
          rows={[pr]}
          error=""
          finished={mode === "finished"}
          runActive={mode === "active"}
          initialUrl={pr.url}
          onClose={() => {}}
          onChanged={() => {}}
        />
      </MouseProvider>,
    );
    try {
      await ready(ui, "api #12");
      if (mode === "active") {
        await ready(ui, "An agent is working");
        await click(ui, "[Fix CI tests]");
        await click(ui, "[Fix merge conflicts]");
      } else assert.doesNotMatch(frame(ui)!, /\[Fix CI tests\]|\[Fix merge conflicts\]/);
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  }
  assert.equal(calls, 0);
});
