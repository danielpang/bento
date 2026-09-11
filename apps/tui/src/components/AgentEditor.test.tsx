import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentProfile, BentoClient } from "@bento/api-client";
import { AgentEditor, type AgentDraft } from "./AgentEditor.js";
import { Setup } from "./Setup.js";

const profile: AgentProfile = {
  id: "reviewer",
  name: "Reviewer",
  cli: "codex",
  model: "gpt-5-codex",
  skill: "# Review\nKeep the tests.",
  extraArgs: ["--verbose"],
};
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

test("pressing e on a saved agent opens its editor, and Enter opens it too", async () => {
  const client = {
    listProjects: async () => [],
    listProfiles: async () => [profile],
    listSecrets: async () => ({ secrets: [], canManage: true }),
    getMachineSettings: async () => null,
    listAgentTools: async () => [],
    mcpStatus: async () => ({ servers: [], canManage: false }),
  } as unknown as BentoClient;
  const ui = render(
    <Setup client={client} agentsRunLocally={false} repositoryPathOwner="server" onDone={() => {}} />,
  );
  try {
    await ready(ui, "Settings");
    ui.stdin.write("j");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Agents");
    ui.stdin.write("e");
    await ready(ui, "Edit agent: Reviewer");
    assert.match(ui.lastFrame()!, /Harness: Codex/);
    assert.match(ui.lastFrame()!, /Model: gpt-5-codex/);
    assert.match(ui.lastFrame()!, /Prompt \(SKILL.md\): # Review/);
    ui.stdin.write("\x1b");
    await ready(ui, "Agents");
    ui.stdin.write("\r");
    await ready(ui, "Edit agent: Reviewer");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("agent edits are saved together and failed saves retain the complete draft", async () => {
  const saves: AgentDraft[] = [];
  let fail = true;
  const ui = render(
    <AgentEditor
      profile={profile}
      onCancel={() => {}}
      onSave={async (draft) => {
        saves.push(draft);
        if (fail) throw new Error("Temporary save failure");
      }}
    />,
  );
  try {
    await ready(ui, "Edit agent: Reviewer");
    await choose(ui, "Harness:", "Choose harness");
    await choose(ui, "Claude Code", "Edit agent: Reviewer");
    await choose(ui, "Model:", "Choose model");
    await choose(ui, "Type a model ID", "Model ID");
    ui.stdin.write("\x15");
    await pause();
    ui.stdin.write("claude-sonnet-5");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Edit agent: Reviewer");
    await choose(ui, "Prompt (SKILL.md):", "Agent prompt (SKILL.md)");
    await choose(ui, "Edit prompt", "Edit agent prompt");
    ui.stdin.write("\x05");
    await pause();
    ui.stdin.write("\x15");
    await pause();
    ui.stdin.write("\x1b[200~# New instructions\nCheck café 🙂\x1b[201~");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Edit agent: Reviewer");
    assert.equal(saves.length, 0);
    await choose(ui, "Save changes", "Temporary save failure");
    assert.deepEqual(saves[0], {
      name: "Reviewer",
      cli: "claude-code",
      model: "claude-sonnet-5",
      skill: "# New instructions\nCheck café 🙂",
      extraArgs: ["--verbose"],
    });
    assert.match(ui.lastFrame()!, /Prompt \(SKILL.md\): # New instructions/);
    fail = false;
    await choose(ui, "Save changes", "Edit agent: Reviewer");
    assert.deepEqual(saves[1], saves[0]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("cancelling a changed agent draft performs no save", async () => {
  let saves = 0,
    cancelled = 0;
  const ui = render(
    <AgentEditor
      profile={profile}
      onSave={async () => {
        saves++;
      }}
      onCancel={() => {
        cancelled++;
      }}
    />,
  );
  try {
    await ready(ui, "Edit agent: Reviewer");
    await choose(ui, "Prompt (SKILL.md):", "Agent prompt (SKILL.md)");
    await choose(ui, "Clear prompt", "Prompt (SKILL.md): No prompt");
    ui.stdin.write("\x1b");
    await pause();
    assert.equal(cancelled, 1);
    assert.equal(saves, 0);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("advanced CLI arguments validate locally and save with the agent prompt", async () => {
  const saves: AgentDraft[] = [];
  const ui = render(
    <AgentEditor
      profile={profile}
      onSave={async (draft) => {
        saves.push(draft);
      }}
      onCancel={() => {}}
    />,
  );
  try {
    await ready(ui, "Edit agent: Reviewer");
    await choose(ui, "Advanced options", "Advanced agent options");
    await choose(ui, "Extra CLI arguments", "Extra CLI arguments (JSON array)");
    assert.match(ui.lastFrame()!, /--verbose/);
    ui.stdin.write("\x15");
    await pause();
    ui.stdin.write("[1]");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Enter an array of strings");
    assert.equal(saves.length, 0);
    ui.stdin.write("\x15");
    await pause();
    ui.stdin.write('["--verbose","--debug"]');
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Edit agent: Reviewer");
    assert.equal(saves.length, 0);
    await choose(ui, "Save changes", "Edit agent: Reviewer");
    assert.deepEqual(saves[0]?.extraArgs, ["--verbose", "--debug"]);
    assert.equal(saves[0]?.skill, profile.skill);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("expanded prompt opens at the beginning, pages through the skill, and preserves the whole draft", async () => {
  const skill = Array.from({ length: 60 }, (_, i) => `Instruction ${String(i + 1).padStart(2, "0")}`).join(
    "\n",
  );
  const saves: AgentDraft[] = [];
  const ui = render(
    <AgentEditor
      profile={{ ...profile, skill }}
      onSave={async (draft) => {
        saves.push(draft);
      }}
      onCancel={() => {}}
    />,
  );
  try {
    await ready(ui, "Edit agent: Reviewer");
    await choose(ui, "Prompt (SKILL.md):", "Agent prompt (SKILL.md)");
    await choose(ui, "Edit prompt", "Edit agent prompt");
    assert.match(ui.lastFrame()!, /Instruction 01/);
    assert.match(ui.lastFrame()!, /Instruction 10/);
    assert.doesNotMatch(ui.lastFrame()!, /Instruction 60/);
    ui.stdin.write("\x1b[6~");
    await pause();
    assert.doesNotMatch(ui.lastFrame()!, /Instruction 01/);
    ui.stdin.write("\x05");
    await pause();
    assert.match(ui.lastFrame()!, /Instruction 60/);
    assert.match(ui.lastFrame()!, /\[Apply to draft\].*\[Cancel\]/);
    ui.stdin.write("\x01");
    await pause();
    assert.match(ui.lastFrame()!, /Instruction 01/);
    ui.stdin.write("Updated: ");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Edit agent: Reviewer");
    assert.equal(saves.length, 0);
    await choose(ui, "Save changes", "Edit agent: Reviewer");
    assert.equal(saves[0]?.skill, `Updated: ${skill}`);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
