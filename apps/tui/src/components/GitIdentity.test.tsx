import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { BentoClient } from "@bento/api-client";
import { GitIdentity } from "./GitIdentity.js";

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function ready(ui: ReturnType<typeof render>, text: string) {
  const end = Date.now() + 5000;
  while (!ui.lastFrame()?.includes(text)) {
    if (Date.now() > end) throw new Error(`Missing ${text}: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await pause();
}
function fixture() {
  const writes: { gitAuthorName: string; gitAuthorEmail: string }[] = [];
  let fail = false;
  const client = {
    getMachineSettings: async () => ({ gitAuthorName: "Original Name", gitAuthorEmail: "old@example.test" }),
    setGitIdentity: async (value: (typeof writes)[number]) => {
      writes.push(value);
      if (fail) throw new Error("Temporary save failure");
      return value;
    },
  } as unknown as BentoClient;
  return {
    client,
    writes,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}
async function replace(ui: ReturnType<typeof render>, value: string) {
  ui.stdin.write("\x05");
  await pause();
  ui.stdin.write("\x15");
  await pause();
  ui.stdin.write(value);
  await pause();
}

test("Git identity edits both fields and submits them together only on Save", async () => {
  const f = fixture();
  const ui = render(<GitIdentity client={f.client} onClose={() => {}} />);
  try {
    await ready(ui, "Original Name");
    assert.match(ui.lastFrame()!, /old@example.test/);
    await replace(ui, "New Name");
    ui.stdin.write("\t");
    await pause();
    await replace(ui, "new@example.test");
    assert.equal(f.writes.length, 0);
    ui.stdin.write("\r");
    await pause();
    assert.equal(f.writes.length, 0);
    ui.stdin.write("\r");
    await ready(ui, "Git identity saved.");
    assert.deepEqual(f.writes, [{ gitAuthorName: "New Name", gitAuthorEmail: "new@example.test" }]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("failed Git identity saves retain both fields for retry", async () => {
  const f = fixture();
  f.setFail(true);
  const ui = render(<GitIdentity client={f.client} onClose={() => {}} />);
  try {
    await ready(ui, "Original Name");
    await replace(ui, "Retry Name");
    ui.stdin.write("\t");
    await pause();
    await replace(ui, "retry@example.test");
    ui.stdin.write("\x13");
    await ready(ui, "Temporary save failure");
    assert.match(ui.lastFrame()!, /Retry Name/);
    assert.match(ui.lastFrame()!, /retry@example.test/);
    f.setFail(false);
    ui.stdin.write("\x13");
    await ready(ui, "Git identity saved.");
    assert.deepEqual(f.writes[1], f.writes[0]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("cancelling Git identity discards the draft without a write", async () => {
  const f = fixture();
  let closed = 0;
  const ui = render(
    <GitIdentity
      client={f.client}
      onClose={() => {
        closed++;
      }}
    />,
  );
  try {
    await ready(ui, "Original Name");
    await replace(ui, "Unsaved");
    ui.stdin.write("\x1b");
    await pause();
    assert.equal(closed, 1);
    assert.equal(f.writes.length, 0);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
