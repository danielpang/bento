import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Form, type FormValues } from "./Form.js";
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function ready(ui: ReturnType<typeof render>, text: string) {
  const end = Date.now() + 5000;
  while (!ui.lastFrame()?.includes(text)) {
    if (Date.now() > end) throw new Error(`Missing ${text}: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await pause();
}

test("a form keeps text and masked secrets when a choice picker opens and closes", async () => {
  const saves: FormValues[] = [];
  const ui = render(
    <Form
      title="Connection"
      fields={[
        { id: "name", label: "Name", required: true },
        { id: "secret", label: "Secret", mask: true },
        {
          id: "scope",
          label: "Scope",
          value: "personal",
          options: [
            { value: "personal", label: "Only you" },
            { value: "org", label: "Organization" },
          ],
        },
      ]}
      onSubmit={(values) => {
        saves.push(values);
      }}
      onCancel={() => {}}
    />,
  );
  try {
    await ready(ui, "Name");
    ui.stdin.write("My connection");
    await pause();
    ui.stdin.write("\t");
    await pause();
    ui.stdin.write("secret-to-mask");
    await pause();
    assert.doesNotMatch(ui.lastFrame()!, /secret-to-mask/);
    ui.stdin.write("\t");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "Organization");
    ui.stdin.write("Organization");
    await pause();
    ui.stdin.write("\r");
    await ready(ui, "My connection");
    assert.match(ui.lastFrame()!, /Organization/);
    assert.doesNotMatch(ui.lastFrame()!, /secret-to-mask/);
    assert.equal(saves.length, 0);
    ui.stdin.write("\x13");
    await pause();
    assert.deepEqual(saves, [{ name: "My connection", secret: "secret-to-mask", scope: "org" }]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("required fields prevent submission and cancelling a multiline draft performs no write", async () => {
  let saves = 0,
    cancels = 0;
  const ui = render(
    <Form
      title="New card"
      fields={[
        { id: "title", label: "Title", required: true },
        { id: "description", label: "Description", multiline: true },
      ]}
      submitLabel="Create card"
      onSubmit={() => {
        saves++;
      }}
      onCancel={() => {
        cancels++;
      }}
    />,
  );
  try {
    await ready(ui, "Description");
    ui.stdin.write("\x13");
    await ready(ui, "Title is required.");
    assert.equal(saves, 0);
    ui.stdin.write("Unsaved title");
    await pause();
    ui.stdin.write("\t");
    await pause();
    ui.stdin.write("\x1b[200~first\nsecond\x1b[201~");
    await pause();
    assert.match(ui.lastFrame()!, /Unsaved title/);
    assert.match(ui.lastFrame()!, /second/);
    ui.stdin.write("\x1b");
    await pause();
    assert.equal(cancels, 1);
    assert.equal(saves, 0);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
