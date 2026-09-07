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
    await ready(ui);
    ui.stdin.write("New task");
    await settle();
    ui.stdin.write("\r");
    await settle();
    ui.stdin.write("\x1b[200~first\nsecond\x1b[201~");
    await settle();
    ui.stdin.write("\r");
    await ready(ui, /Try again later/);
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

test("message submission stays on the original card when the board selection changes", async () => {
  const paths: string[] = [];
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async (url) => {
      paths.push(String(url));
      return new Response(JSON.stringify({ queued: true }));
    }) as typeof fetch,
  });
  const ui = render(workspace(client, "message"));
  try {
    await ready(ui);
    ui.stdin.write("Please check the edge case");
    await settle();
    ui.rerender(workspace(client, "message", { ...card, id: "different-card" }));
    await settle();
    ui.stdin.write("\r");
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(paths, ["http://bento.test/api/features/card/message"]);
    assert.match(ui.lastFrame()!, /Queued/);
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
