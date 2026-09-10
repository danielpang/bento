import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { BentoClient, type Feature, type Project } from "@bento/api-client";
import { Workbench, type WorkbenchPage } from "./Workbench.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
// Ink's first render waits for Yoga and effects. Do not send keys before it is ready.
async function ready(ui: ReturnType<typeof render>, expected: RegExp = /\S/) {
  const deadline = Date.now() + 5000;
  while (!expected.test(ui.lastFrame() ?? "") || /^(Loading|Working)…$/.test((ui.lastFrame() ?? "").trim())) {
    if (Date.now() > deadline) throw new Error(`TUI did not become ready: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await settle();
}

const project = { id: "project", name: "Second project", autoStartPipeline: false } as Project;
const card = {
  id: "card",
  projectId: project.id,
  title: "Original card",
  description: "",
  status: "active",
  currentStageId: "stage",
  branchName: null,
  prNumber: null,
} as Feature;
function workspace(client: BentoClient, initial: WorkbenchPage, feature = card, beta = false) {
  return (
    <Workbench
      client={client}
      baseUrl="http://bento.test"
      initial={initial}
      project={project}
      projects={[project]}
      feature={feature}
      features={[feature]}
      stages={[]}
      profiles={[]}
      beta={beta}
      onProject={() => {}}
      onFeature={() => {}}
      onSetup={() => {}}
      onAction={() => {}}
      onClose={() => {}}
      onChanged={async () => {}}
    />
  );
}

test("failed card creation keeps the description for retry and uses the chosen project", async () => {
  const bodies: unknown[] = [];
  let fail = true;
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(fail ? { error: "Try again later" } : { ...card, title: "New task" }),
        { status: fail ? 503 : 201 },
      );
    }) as typeof fetch,
  });
  const ui = render(workspace(client, "new"));
  try {
    await ready(ui, /Description \(optional\)/);
    assert.match(ui.lastFrame()!, /Title/);
    ui.stdin.write("New task");
    await settle();
    ui.stdin.write("\r");
    await settle();
    ui.stdin.write("\x1b[200~first\nsecond\x1b[201~");
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.equal(bodies.length, 0);
    ui.stdin.write("\r");
    await ready(ui, /Try again later/);
    assert.match(ui.lastFrame()!, /New task/);
    assert.match(ui.lastFrame()!, /second/);
    fail = false;
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(bodies, [
      { projectId: "project", title: "New task", description: "first\nsecond" },
      { projectId: "project", title: "New task", description: "first\nsecond" },
    ]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("inline message submission stays on the original card when the board selection changes", async () => {
  const paths: string[] = [];
  const client = {
    getConversation: async () => ({ blocks: [], pending: [] }),
    getFeature: async () => ({ ...card, runs: [] }),
    listArtifacts: async () => [],
    streamBoard: () => () => {},
    messageFeature: async (id: string) => {
      paths.push(id);
      return { queued: true };
    },
  } as unknown as BentoClient;
  const ui = render(workspace(client, "message"));
  try {
    await ready(ui, /Reply to agent/);
    ui.stdin.write("Please check the edge case");
    await settle();
    ui.rerender(workspace(client, "message", { ...card, id: "different-card" }));
    await settle();
    ui.stdin.write("\r");
    ui.stdin.write("\r");
    await ready(ui, /Queued/);
    assert.deepEqual(paths, ["card"]);
    assert.match(ui.lastFrame()!, /Conversation/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("non-testers are not offered related-card beta actions", async () => {
  const client = new BentoClient({ baseUrl: "http://bento.test" });
  const ui = render(workspace(client, "commands"));
  try {
    await ready(ui);
    ui.stdin.write("related");
    await settle();
    assert.match(ui.lastFrame()!, /No matches/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("commands have one Settings entry and integrations contain only integrations", async () => {
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async () => new Response(JSON.stringify({ mode: "local" }))) as typeof fetch,
  });
  for (const page of ["commands", "integrations"] as const) {
    const ui = render(workspace(client, page));
    try {
      await ready(ui);
      assert.doesNotMatch(
        ui.lastFrame()!,
        /Edit agent operating instructions|Agent operating instructions and CLI arguments|Stage instructions and order|Team, organizations|Billing, plans/,
      );
      assert.match(
        ui.lastFrame()!,
        page === "commands" ? /Settings/ : /GitHub connection and pull request settings/,
      );
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  }
});

test("a successful card creation does not offer another creation when board refresh fails", async () => {
  let writes = 0,
    closed = 0;
  const client = {
    createFeature: async () => {
      writes++;
      return card;
    },
  } as unknown as BentoClient;
  const ui = render(
    React.cloneElement(workspace(client, "new"), {
      onChanged: async () => {
        throw new Error("Refresh unavailable");
      },
      onClose: () => {
        closed++;
      },
    }),
  );
  try {
    await ready(ui, /Description/);
    ui.stdin.write("Created once");
    await settle();
    ui.stdin.write("\x13");
    await settle();
    assert.equal(writes, 1);
    assert.equal(closed, 1);
    assert.doesNotMatch(ui.lastFrame()!, /Refresh unavailable/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("related-card creation keeps the parent and accepts an optional description", async () => {
  const bodies: unknown[] = [];
  const client = {
    createFeature: async (body: unknown) => {
      bodies.push(body);
      return { ...card, id: "child" };
    },
  } as unknown as BentoClient;
  const ui = render(workspace(client, "commands", card, true));
  try {
    await ready(ui);
    ui.stdin.write("Create a related card");
    await settle();
    ui.stdin.write("\r");
    await ready(ui, /New related card/);
    assert.match(ui.lastFrame()!, /Description/);
    ui.stdin.write("Child card");
    await settle();
    ui.stdin.write("\x13");
    await settle();
    assert.deepEqual(bodies, [
      { projectId: "project", title: "Child card", description: "", parentId: "card" },
    ]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("project creation can save a name before a repository is connected", async () => {
  const bodies: unknown[] = [];
  const client = {
    createProject: async (body: unknown) => {
      bodies.push(body);
      return project;
    },
  } as unknown as BentoClient;
  const ui = render(workspace(client, "projects"));
  try {
    await ready(ui);
    ui.stdin.write("Create project");
    await settle();
    ui.stdin.write("\r");
    await ready(ui, /Repository path/);
    ui.stdin.write("Future project");
    await settle();
    ui.stdin.write("\x13");
    await settle();
    assert.deepEqual(bodies, [{ name: "Future project" }]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("stage artifact navigation reads the selected file and returns to conversation history", async () => {
  const readIds: string[] = [];
  const client = {
    getConversation: async () => ({ blocks: [], pending: [] }),
    getFeature: async () => ({ ...card, runs: [] }),
    streamBoard: () => () => {},
    listArtifacts: async () => [
      {
        id: "plan-file",
        runId: "r1",
        stageSlug: "plan",
        stageName: "Plan",
        path: "notes.md",
        kind: "markdown",
        mime: "text/markdown",
        size: 12,
      },
      {
        id: "build-file",
        runId: "r2",
        stageSlug: "build",
        stageName: "Build",
        path: "notes.md",
        kind: "markdown",
        mime: "text/markdown",
        size: 12,
      },
    ],
    getArtifactText: async (id: string) => {
      readIds.push(id);
      return "Build artifact content";
    },
  } as unknown as BentoClient;
  const ui = render(
    workspace(client, "conversation", {
      ...card,
      description: Array.from({ length: 70 }, (_, i) => `Brief line ${i}`).join("\n"),
    }),
  );
  try {
    await ready(ui, /Brief line 69/);
    ui.stdin.write("g");
    await ready(ui, /Brief line 0\b/);
    ui.stdin.write("a");
    await ready(ui, /Artifacts by stage/);
    ui.stdin.write("Build");
    await settle();
    ui.stdin.write("\r");
    await ready(ui, /Build · 1 artifacts/);
    ui.stdin.write("\r");
    await ready(ui, /Read source as text/);
    ui.stdin.write("\r");
    await ready(ui, /Build artifact content/);
    assert.deepEqual(readIds, ["build-file"], "same-named artifacts remain scoped to their stage");
    for (const expected of [
      /Read source as text/,
      /Build · 1 artifacts/,
      /Artifacts by stage/,
      /Brief line 0\b/,
    ]) {
      ui.stdin.write("\x1b");
      await ready(ui, expected);
    }
    assert.match(ui.lastFrame()!, /Reading history/);
    assert.doesNotMatch(ui.lastFrame()!, /Brief line 69/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("sessions open the selected conversation directly and Back returns to the sessions picker", async () => {
  const requested: string[] = [];
  const sessionCard = { ...card, id: "session-card", title: "Session conversation" };
  const client = {
    listSessions: async () => ({
      sessions: [
        {
          featureId: sessionCard.id,
          title: sessionCard.title,
          latestRun: { status: "succeeded" },
          runCount: 2,
        },
      ],
    }),
    getFeature: async (id: string) => {
      requested.push(id);
      return { ...sessionCard, runs: [], pullRequestHistory: [] };
    },
    getConversation: async (id: string) => {
      assert.equal(id, sessionCard.id);
      return { blocks: [], pending: [] };
    },
    listArtifacts: async () => [],
    streamBoard: () => () => {},
  } as unknown as BentoClient;
  const ui = render(workspace(client, "sessions"));
  try {
    await ready(ui, /Sessions/);
    ui.stdin.write("\r");
    await ready(ui, /Reply/);
    assert.match(ui.lastFrame()!, /Session conversation/);
    assert.doesNotMatch(ui.lastFrame()!, /Original card/);
    assert.ok(requested.length > 0 && requested.every((id) => id === sessionCard.id));
    ui.stdin.write("\x1b");
    await ready(ui, /2 runs/);
    assert.match(ui.lastFrame()!, /Sessions/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
