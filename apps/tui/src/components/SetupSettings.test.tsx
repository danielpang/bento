import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { BentoClient, Repository, Stage } from "@bento/api-client";
import { Setup, type SettingsSection } from "./Setup.js";

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function ready(ui: ReturnType<typeof render>, text: string) {
  const end = Date.now() + 5000;
  while (!ui.lastFrame()?.includes(text)) {
    if (Date.now() > end) throw new Error(`Missing ${text}: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await pause();
}
async function choose(ui: ReturnType<typeof render>, label: string, expected: string) {
  ui.stdin.write(label);
  await pause();
  ui.stdin.write("\r");
  await ready(ui, expected);
}
function fixture() {
  let repositories: Repository[] = [];
  let stages = [
    {
      id: "plan",
      name: "Plan",
      description: "Original prompt",
      position: 0,
      gateType: "auto",
      gateCriteria: [{ type: "manual" }, { type: "run_succeeded" }],
      createPr: false,
    },
    { id: "build", name: "Build", position: 1, gateType: "manual", gateCriteria: [], createPr: false },
  ] as Stage[];
  const updates: unknown[] = [],
    orders: string[][] = [];
  const client = {
    listProjects: async () => [{ id: "project", name: "Project" }],
    listProfiles: async () => [],
    listSecrets: async () => ({ secrets: [], canManage: true }),
    getMachineSettings: async () => ({ mode: "local", logins: [] }),
    listAgentTools: async () => [],
    listRepositories: async () => repositories,
    addRepository: async (projectId: string, input: { localPath?: string }) => {
      const row: Repository = {
        id: `repo-${repositories.length + 1}`,
        projectId,
        name: path.basename(input.localPath ?? "repo"),
        localPath: input.localPath ?? "",
        repoUrl: null,
        githubRepoId: null,
        defaultBranch: "main",
        setupCommand: null,
        testCommand: null,
      };
      repositories = [...repositories, row];
      return row;
    },
    getPipeline: async () => ({ id: "pipeline", stages }),
    updateStage: async (id: string, patch: Partial<Stage>) => {
      updates.push(patch);
      stages = stages.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage));
    },
    reorderStages: async (_id: string, ids: string[]) => {
      orders.push(ids);
      stages = ids.map((id, position) => ({ ...stages.find((stage) => stage.id === id)!, position }));
    },
  } as unknown as BentoClient;
  return {
    client,
    updates,
    orders,
    setRepositories: (rows: Repository[]) => { repositories = rows; },
    setStages: (rows: Stage[]) => { stages = rows; },
    addStage: () => {
      stages.push({ id: "new", name: "New", position: 2 } as Stage);
    },
  };
}

test("pipeline remains visible when an unrelated Settings request fails", async () => {
  const f = fixture();
  f.client.listRepositories = async () => { throw new Error("repository lookup failed"); };
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} selectedProjectId="project" onDone={() => {}} />,
  );
  try {
    await ready(ui, "0 of 2 have an agent");
    ui.stdin.write("j");
    ui.stdin.write("j");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "1. Plan");
    assert.match(ui.lastFrame()!, /2\. Build/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("opening pipeline settings reloads all six stages from the board project", async () => {
  const f = fixture();
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} selectedProjectId="project" onDone={() => {}} />,
  );
  try {
    await ready(ui, "0 of 2 have an agent");
    const names = ["Plan", "Build", "Review", "Test", "Ship", "Done"];
    f.setStages(names.map((name, position) => ({
      id: `stage-${position}`,
      name,
      position,
      gateType: "manual",
      gateCriteria: [],
      createPr: false,
    } as Stage)));
    ui.stdin.write("j");
    ui.stdin.write("j");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "6. Done");
    assert.match(ui.lastFrame()!, /1\. Plan/);
    ui.stdin.write("\x1b");
    await ready(ui, "0 of 6 have an agent");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("pipeline load failure is shown instead of zero stages", async () => {
  const f = fixture();
  f.client.getPipeline = async () => { throw new Error("pipeline lookup failed"); };
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} selectedProjectId="project" onDone={() => {}} />,
  );
  try {
    await ready(ui, "could not load stages");
    assert.doesNotMatch(ui.lastFrame()!, /0 of 0 have an agent/);
    ui.stdin.write("j");
    ui.stdin.write("j");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Could not load pipeline: pipeline lookup failed");
    assert.doesNotMatch(ui.lastFrame()!, /Add stage/);
    f.client.getPipeline = async () => ({
      id: "pipeline",
      stages: [{ id: "plan", name: "Plan", position: 0, gateType: "manual", gateCriteria: [], createPr: false }],
    } as Awaited<ReturnType<BentoClient["getPipeline"]>>);
    ui.stdin.write("r");
    await ready(ui, "1. Plan");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("repositories page refreshes and lists the selected project's saved repositories", async () => {
  const f = fixture();
  const first: Repository = {
    id: "repo-one",
    projectId: "project",
    name: "app",
    localPath: "/work/app",
    repoUrl: null,
    githubRepoId: null,
    defaultBranch: "main",
    setupCommand: null,
    testCommand: null,
  };
  const second: Repository = { ...first, id: "repo-two", name: "api", localPath: "/work/api" };
  f.setRepositories([first]);
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} selectedProjectId="project" onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    f.setRepositories([first, second]);
    ui.stdin.write("\r");
    await ready(ui, "Repositories · Project");
    assert.match(ui.lastFrame()!, /app · \/work\/app/);
    assert.match(ui.lastFrame()!, /api · \/work\/api/);
    assert.match(ui.lastFrame()!, /Add another repository/);

    ui.stdin.write("\x1b");
    await ready(ui, "Settings");
    f.setRepositories([]);
    ui.stdin.write("\r");
    await ready(ui, "No repositories connected to Project");
    assert.match(ui.lastFrame()!, /Add repository/);
    assert.doesNotMatch(ui.lastFrame()!, /Add another repository/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("leaving a repository refresh returns to Settings immediately", async () => {
  const f = fixture();
  let calls = 0;
  let release = () => {};
  const pending = new Promise<Repository[]>((resolve) => { release = () => resolve([]); });
  f.client.listRepositories = async () => ++calls === 1 ? [] : pending;
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    ui.stdin.write("\r");
    await ready(ui, "Loading repositories");
    ui.stdin.write("\x1b");
    await ready(ui, "Settings");
    release();
    await pause();
    assert.match(ui.lastFrame()!, /Configure this project/);
  } finally {
    release();
    ui.unmount();
    ui.cleanup();
  }
});

test("connecting a repository succeeds even if an unrelated settings refresh would fail", async () => {
  const f = fixture();
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    ui.stdin.write("\r");
    await ready(ui, "No repositories connected to Project");
    ui.stdin.write("\r");
    await ready(ui, "Connect a repository");
    f.client.listProfiles = async () => { throw new Error("profile refresh failed"); };
    ui.stdin.write("/work/app");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "app · /work/app");
    assert.doesNotMatch(ui.lastFrame()!, /profile refresh failed/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("connecting an existing checkout explains the duplicate before sending it", async () => {
  const f = fixture();
  f.setRepositories([{
    id: "repo-one",
    projectId: "project",
    name: "bento",
    localPath: "/work/bento",
    repoUrl: null,
    githubRepoId: null,
    defaultBranch: "main",
    setupCommand: null,
    testCommand: null,
  }]);
  let addCalls = 0;
  f.client.addRepository = async () => {
    addCalls += 1;
    throw new Error("the server should not be called");
  };
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    ui.stdin.write("\r");
    await ready(ui, "Add another repository");
    ui.stdin.write("j");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Connect a repository");
    ui.stdin.write("/work/bento/");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "This checkout is already connected as bento.");
    assert.equal(addCalls, 0);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("stage editor owns prompts, gate mode and ordering, preserving concurrent additions", async () => {
  const f = fixture();
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="server" agentsRunLocally={false} onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    for (let i = 0; i < 2; i++) {
      ui.stdin.write("j");
      await pause();
    }
    ui.stdin.write("\r");
    await ready(ui, "Import or export pipeline");
    ui.stdin.write("\r");
    await ready(ui, "Stage: Plan");
    assert.match(ui.lastFrame()!, /Advancement: Manual approval/);
    await choose(ui, "Prompt:", "Stage prompt");
    ui.stdin.write("\x15");
    await pause();
    ui.stdin.write("\x1b[200~New prompt\nKeep café 🙂\x1b[201~");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Stage: Plan");
    assert.deepEqual(f.updates[0], { description: "New prompt\nKeep café 🙂" });
    await choose(ui, "Advancement:", "Stage advancement");
    await choose(ui, "Automatic", "Stage: Plan");
    assert.deepEqual(f.updates[1], { gateType: "auto", gateCriteria: [{ type: "run_succeeded" }] });
    f.addStage();
    await choose(ui, "Move stage later", "Stage: Plan");
    assert.deepEqual(f.orders, [["build", "plan", "new"]]);
    // The title also exists before the save finishes. Wait for the refreshed menu before Escape.
    await ready(ui, "Move stage earlier");
    ui.stdin.write("\x1b");
    await ready(ui, "Import or export pipeline");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("hosted settings expose team, account and billing without duplicate integration editors", async () => {
  let section: SettingsSection | undefined;
  const ui = render(
    <Setup
      client={fixture().client}
      repositoryPathOwner="server"
      agentsRunLocally={false}
      serverMode="multi"
      onSection={(value) => {
        section = value;
      }}
      onDone={() => {}}
    />,
  );
  try {
    await ready(ui, "Settings");
    assert.match(ui.lastFrame()!, /Team/);
    assert.match(ui.lastFrame()!, /Account/);
    assert.match(ui.lastFrame()!, /Billing/);
    assert.doesNotMatch(
      ui.lastFrame()!,
      /GitHub \(pull requests\)|MCP servers|Pipeline file|Share agent logins/,
    );
    for (let i = 0; i < 4; i++) {
      ui.stdin.write("j");
      await pause();
    }
    ui.stdin.write("\r");
    await pause();
    assert.equal(section, "mcp");
    ui.stdin.write("j");
    await pause();
    ui.stdin.write("\r");
    await pause();
    assert.equal(section, "integrations");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("local agent sign-ins own the credential sharing controls", async () => {
  const f = fixture();
  let sharing = false;
  f.client.getMachineSettings = async () =>
    ({
      mode: "local",
      logins: [{ cli: "codex", label: "Codex CLI", signedIn: false }],
      shareAgentAuth: sharing,
      pinnedByEnv: false,
    }) as Awaited<ReturnType<BentoClient["getMachineSettings"]>>;
  f.client.setShareAgentAuth = async (next) => {
    sharing = next;
    return { shareAgentAuth: next };
  };
  const ui = render(
    <Setup
      client={f.client}
      repositoryPathOwner="server"
      agentsRunLocally
      serverMode="local"
      onSection={() => {}}
      onDone={() => {}}
    />,
  );
  try {
    await ready(ui, "Settings");
    assert.match(ui.lastFrame()!, /Share agent logins/);
    assert.doesNotMatch(ui.lastFrame()!, /Subscriptions on this machine|Toggle sharing/);
    for (let i = 0; i < 3; i++) {
      ui.stdin.write("j");
      await pause();
    }
    ui.stdin.write("\r");
    await ready(ui, "Share with Bento: Off");
    assert.match(ui.lastFrame()!, /Share agent logins/);
    assert.match(ui.lastFrame()!, /1\. Sign in to a coding tool/);
    assert.match(ui.lastFrame()!, /2\. Share with Bento: Off/);
    assert.match(ui.lastFrame()!, /Share logins/);
    assert.match(ui.lastFrame()!, /Sign in to Claude/);
    ui.stdin.write("s");
    await ready(ui, "Share with Bento: On");
    assert.equal(sharing, true);
    assert.match(ui.lastFrame()!, /Stop sharing/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("remote runner sign-ins show the launch flag instead of a dead toggle", async () => {
  const f = fixture();
  f.client.getMachineSettings = async () =>
    ({ mode: "multi", shareAgentAuth: false, logins: [] }) as Awaited<ReturnType<BentoClient["getMachineSettings"]>>;
  const ui = render(
    <Setup
      client={f.client}
      repositoryPathOwner="client"
      agentsRunLocally
      runnerMode
      serverMode="multi"
      onDone={() => {}}
    />,
  );
  try {
    await ready(ui, "Settings");
    for (let i = 0; i < 3; i++) {
      ui.stdin.write("j");
      await pause();
    }
    ui.stdin.write("\r");
    await ready(ui, "Restart Bento with --share-agent-auth");
    assert.match(ui.lastFrame()!, /Share with Bento: Off/);
    assert.doesNotMatch(ui.lastFrame()!, /Share logins|Toggle sharing/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("Claude sign-in reports missing credentials, then shows the next sharing step", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bento-claude-login-"));
  const bin = path.join(home, "bin");
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  await mkdir(bin);
  await writeFile(
    path.join(home, "staged-credentials"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 60_000 } }),
  );
  await writeFile(
    path.join(bin, "claude"),
    "#!/bin/sh\nexit 0\n",
  );
  await writeFile(
    path.join(bin, "security"),
    '#!/bin/sh\ncat "$HOME/.claude/.credentials.json"\n',
  );
  await Promise.all([chmod(path.join(bin, "claude"), 0o755), chmod(path.join(bin, "security"), 0o755)]);
  process.env.HOME = home;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;

  const f = fixture();
  f.client.getMachineSettings = async () =>
    ({ mode: "multi", shareAgentAuth: false, logins: [] }) as Awaited<ReturnType<BentoClient["getMachineSettings"]>>;
  const ui = render(
    <Setup client={f.client} repositoryPathOwner="client" agentsRunLocally runnerMode serverMode="multi" onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    for (let i = 0; i < 3; i++) {
      ui.stdin.write("j");
      await pause();
    }
    ui.stdin.write("\r");
    await ready(ui, "Share with Bento: Off");
    ui.stdin.write("l");
    await ready(ui, "Bento cannot read a usable login");
    await writeFile(
      path.join(bin, "claude"),
      '#!/bin/sh\nmkdir -p "$HOME/.claude"\nmv "$HOME/staged-credentials" "$HOME/.claude/.credentials.json"\n',
    );
    await chmod(path.join(bin, "claude"), 0o755);
    ui.stdin.write("l");
    await ready(ui, "Claude is signed in. Restart Bento with --share-agent-auth");
    assert.match(ui.lastFrame()!, /Claude Code: Ready to share/);
  } finally {
    ui.unmount();
    ui.cleanup();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(home, { recursive: true, force: true });
  }
});
