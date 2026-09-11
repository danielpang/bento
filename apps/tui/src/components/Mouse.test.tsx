import assert from "node:assert/strict";
import test from "node:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { createClickTracker, isMouseInput, parseMouse } from "../mouse.js";
import { TextInput, cursorAtCell, editorWindow } from "./TextInput.js";
import { Navigator } from "./Navigator.js";
import { kanbanViewport } from "./Kanban.js";
import { MouseProvider, useMouseTarget } from "../mouse.js";
import { MouseButton } from "./MouseControls.js";
import { Box } from "ink";
import { stripVTControlCharacters } from "node:util";

test("SGR mouse reports decode clicks, releases, wheel directions and large coordinates", () => {
  assert.deepEqual(parseMouse("\x1b[<0;120;8M"), { x: 119, y: 7, kind: "click" });
  assert.deepEqual(parseMouse("[<0;120;8m"), { x: 119, y: 7, kind: "release" });
  for (const [button, kind] of [
    [64, "up"],
    [65, "down"],
    [66, "left"],
    [67, "right"],
    [68, "left"],
    [69, "right"],
  ] as const) {
    assert.deepEqual(parseMouse(`[<${button};300;42M`), { x: 299, y: 41, kind });
  }
});

test("right clicks, motion, modifiers, invalid coordinates and non-mouse input never activate cards", () => {
  for (const input of [
    "[<2;12;8M",
    "[<32;12;8M",
    "[<4;12;8M",
    "[<16;12;8M",
    "[<8;12;8M",
    "[<0;0;8M",
    "[<0;1;0M",
    "[<0;99999999999999999999;1M",
    "[<256;1;1M",
    "[<0;1;1",
    "a",
    "[A",
    "[<65;12;8m",
  ]) {
    assert.equal(parseMouse(input), null, input);
  }
  assert.equal(isMouseInput("[<0;1;1"), true);
  assert.equal(isMouseInput("Hello"), false);
});

test("double-clicks require the same card and position within the interval", () => {
  const clicks = createClickTracker();
  const event = { x: 10, y: 8, kind: "click" as const };
  assert.equal(clicks.click("a", event, 1000), false);
  assert.equal(clicks.click("a", event, 1250), true);
  assert.equal(clicks.click("a", event, 1300), false);
  assert.equal(clicks.click("b", event, 1400), false);
  assert.equal(clicks.click("b", { ...event, x: 20 }, 1500), false);
  assert.equal(clicks.click("b", { ...event, x: 20 }, 2000), false);
  clicks.reset();
  assert.equal(clicks.click("b", { ...event, x: 20 }, 2100), false);
});

test("selecting another visible Kanban column does not move it away from the pointer", () => {
  for (const focused of [0, 1, 2, 3]) assert.equal(kanbanViewport(100, 24, 8, focused, 0).start, 0);
  assert.equal(kanbanViewport(100, 24, 8, 4, 0).start, 1);
  assert.equal(kanbanViewport(100, 24, 8, 0, 1).start, 0);
});

test("mouse cursor placement respects wrapped lines, Unicode width and grapheme boundaries", () => {
  assert.equal(cursorAtCell("abcXYZ", 30, 3, 0), 3);
  assert.equal(cursorAtCell("a\tb", 30, 2, 0), 2);
  assert.equal(cursorAtCell("abc\ndef", 30, 2, 1), 6);
  assert.equal(cursorAtCell("abcde", 3, 1, 1), 4);
  assert.equal(cursorAtCell("a🙂b", 30, 2, 0), 1);
  assert.equal(cursorAtCell("a🙂b", 30, 3, 0), 2);
  assert.equal(cursorAtCell("e\u0301x", 30, 1, 0), 2);
  assert.equal(cursorAtCell("family 👨‍👩‍👧‍👦 end", 30, 8, 0), 7);
  assert.equal(cursorAtCell("hello", 30, 25, 0), 5);
});

test("multiline editor windows keep short pasted lines and wide glyphs within the viewport", () => {
  const text = "x\n".repeat(40) + "tail";
  const last = editorWindow(text, text.length, 30, 4);
  assert.equal(text.slice(last.start, last.end), "x\nx\nx\ntail");
  const first = editorWindow(text, 0, 30, 4);
  assert.equal(text.slice(first.start, first.end), "x\nx\nx\nx");
  assert.deepEqual(editorWindow("界".repeat(10), 10, 4, 2), { start: 8, end: 10 });
});

async function ready(ui: ReturnType<typeof render>, text: string) {
  const end = Date.now() + 5000;
  while (!ui.lastFrame()?.includes(text)) {
    if (Date.now() > end) throw new Error(`Missing ${text}: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

test("late mouse reports cannot corrupt a text field after leaving the board", async () => {
  const submitted: string[] = [];
  function Editor() {
    const [value, setValue] = useState("Draft");
    return <TextInput value={value} onChange={setValue} onSubmit={(value) => submitted.push(value)} />;
  }
  const ui = render(<Editor />);
  try {
    await ready(ui, "Draft");
    ui.stdin.write("\x1b[<0;12;8m\x1b[<65;12;8M");
    await ready(ui, "Draft");
    ui.stdin.write("\r");
    await ready(ui, "Draft");
    assert.deepEqual(submitted, ["Draft"]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("mouse reports do not filter menus or activate choices", async () => {
  let selected = false;
  const ui = render(
    <Navigator
      title="Commands"
      choices={[
        {
          id: "a",
          label: "Choose card",
          select: () => {
            selected = true;
          },
        },
      ]}
      onClose={() => {}}
    />,
  );
  try {
    await ready(ui, "Choose card");
    ui.stdin.write("\x1b[<0;12;8M\x1b[<0;12;8m");
    await ready(ui, "Choose card");
    assert.doesNotMatch(ui.lastFrame()!, /No matches|\[</);
    assert.equal(selected, false);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

const mouseFrame = (ui: ReturnType<typeof render>) =>
  ui.frames
    .map(stripVTControlCharacters)
    .filter((frame) => frame.trim())
    .at(-1) ?? "";
async function mouseReady(ui: ReturnType<typeof render>, text: string) {
  const end = Date.now() + 5000;
  while (!mouseFrame(ui).includes(text)) {
    if (Date.now() > end) throw new Error(mouseFrame(ui));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
function mouseClick(ui: ReturnType<typeof render>, label: string) {
  const lines = mouseFrame(ui).split("\n");
  const y = lines.findIndex((line) => line.includes(label));
  assert.ok(y >= 0, mouseFrame(ui));
  const x = lines[y]!.indexOf(label);
  ui.stdin.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
}

test("the shared dispatcher activates the nested button once, not its parent", async () => {
  let parent = 0,
    child = 0;
  function Controls() {
    const ref = useMouseTarget({
      onClick: () => {
        parent++;
      },
    });
    return (
      <Box ref={ref}>
        <MouseButton
          label="Save"
          onClick={() => {
            child++;
          }}
        />
      </Box>
    );
  }
  const ui = render(
    <MouseProvider enabled>
      <Controls />
    </MouseProvider>,
  );
  try {
    await mouseReady(ui, "Save");
    mouseClick(ui, "Save");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child, 1);
    assert.equal(parent, 0);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("a double-click cannot fall through a menu into the confirmation at the same position", async () => {
  let confirmed = 0;
  function Screens() {
    const [confirm, setConfirm] = useState(false);
    return confirm ? (
      <MouseButton
        key="confirm"
        label="Confirm"
        onClick={() => {
          confirmed++;
        }}
      />
    ) : (
      <MouseButton key="open" label="Open" onClick={() => setConfirm(true)} />
    );
  }
  const ui = render(
    <MouseProvider enabled>
      <Screens />
    </MouseProvider>,
  );
  try {
    await mouseReady(ui, "Open");
    mouseClick(ui, "Open");
    await mouseReady(ui, "Confirm");
    mouseClick(ui, "Confirm");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(confirmed, 0);
    ui.stdin.write("x"); // An intentional keyboard interaction ends the double-click sequence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    mouseClick(ui, "Confirm");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(confirmed, 1);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("menu clicks invoke the exact displayed choice after filtering", async () => {
  let picked = "";
  const ui = render(
    <MouseProvider enabled>
      <Navigator
        title="Pick"
        choices={[
          {
            id: "a",
            label: "Alpha",
            select: () => {
              picked = "a";
            },
          },
          {
            id: "b",
            label: "Beta",
            select: () => {
              picked = "b";
            },
          },
        ]}
        onClose={() => {}}
      />
    </MouseProvider>,
  );
  try {
    await mouseReady(ui, "Beta");
    ui.stdin.write("Bet");
    await mouseReady(ui, "› Beta");
    mouseClick(ui, "› Beta");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(picked, "b");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
