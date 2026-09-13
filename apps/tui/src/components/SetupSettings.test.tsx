import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { BentoClient, Stage } from "@bento/api-client";
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
    listRepositories: async () => [],
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
    addStage: () => {
      stages.push({ id: "new", name: "New", position: 2 } as Stage);
    },
  };
}

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
      /GitHub \(pull requests\)|MCP servers|Pipeline file|Local agent sign-ins/,
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
  f.client.getMachineSettings = async () =>
    ({
      mode: "local",
      logins: [{ cli: "codex", label: "Codex CLI", signedIn: false }],
      shareAgentAuth: false,
      pinnedByEnv: false,
    }) as Awaited<ReturnType<BentoClient["getMachineSettings"]>>;
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
    assert.match(ui.lastFrame()!, /Local agent sign-ins/);
    assert.doesNotMatch(ui.lastFrame()!, /Subscriptions on this machine|Toggle sharing/);
    for (let i = 0; i < 3; i++) {
      ui.stdin.write("j");
      await pause();
    }
    ui.stdin.write("\r");
    await ready(ui, "Sharing is");
    assert.match(ui.lastFrame()!, /Local agent sign-ins/);
    assert.match(ui.lastFrame()!, /Toggle sharing/);
    assert.match(ui.lastFrame()!, /Sign in to Claude/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
