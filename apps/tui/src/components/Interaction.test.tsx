import assert from "node:assert/strict";
import test from "node:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { TextInput } from "./TextInput.js";
import { Navigator, Reader } from "./Navigator.js";
import { matchesSearch, terminalText, wrapLines } from "../terminal.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("editor waits for pending paste before allowing submission", async () => {
  const submitted: string[] = [];
  let finishPaste!: (handled: boolean) => void;
  const paste = new Promise<boolean>((resolve) => {
    finishPaste = resolve;
  });
  function Editor() {
    const [value, setValue] = useState("original");
    return (
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => submitted.push(text)}
        onPasteContent={() => paste}
      />
    );
  }
  const ui = render(<Editor />);
  try {
    await ready(ui, /original/);
    ui.stdin.write("\x1b[200~ pasted\x1b[201~");
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(submitted, []);
    finishPaste(false);
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(submitted, ["original pasted"]);
  } finally {
    finishPaste(false);
    ui.unmount();
  }
});
// Ink's first render waits for Yoga and effects. Do not send keys before it is ready.
async function ready(ui: ReturnType<typeof render>, expected: RegExp = /.*/) {
  const deadline = Date.now() + 5000;
  while (
    ui.lastFrame() === undefined ||
    !expected.test(ui.lastFrame() ?? "") ||
    /^(Loading|Working)…$/.test((ui.lastFrame() ?? "").trim())
  ) {
    if (Date.now() > deadline) throw new Error(`TUI did not become ready: ${ui.lastFrame()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await settle();
}

test("editor handles fast typing, cursor insertion, deletion, and explicit submission", async () => {
  const submitted: string[] = [];
  function Editor() {
    const [value, setValue] = useState("");
    return <TextInput value={value} onChange={setValue} onSubmit={(text) => submitted.push(text)} />;
  }
  const ui = render(<Editor />);
  try {
    await ready(ui);
    ui.stdin.write("a");
    ui.stdin.write("b");
    ui.stdin.write("c");
    await settle();
    ui.stdin.write("\x1b[D");
    await settle();
    ui.stdin.write("X");
    await settle();
    ui.stdin.write("\x7f");
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(submitted, ["abc"]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("bracketed multiline paste preserves text without submitting or firing shortcuts", async () => {
  const submitted: string[] = [];
  let value = "";
  function Editor() {
    const [text, setText] = useState("");
    return (
      <TextInput
        value={text}
        multiline
        onChange={(next) => {
          value = next;
          setText(next);
        }}
        onSubmit={(next) => submitted.push(next)}
      />
    );
  }
  const ui = render(<Editor />);
  try {
    await ready(ui);
    ui.stdin.write("\x1b[200~first\n\tsecond\x1b[201~");
    await settle();
    assert.equal(submitted.length, 0);
    assert.equal(value, "first\n\tsecond");
    assert.match(ui.lastFrame() ?? "", /⇥second/);
    assert.doesNotMatch(ui.lastFrame() ?? "", /\t/);
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(submitted, ["first\n\tsecond"]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("control keys edit without being inserted as letters and Unicode backspace stays valid", async () => {
  const submitted: string[] = [];
  function Editor() {
    const [value, setValue] = useState("hi 🙂");
    return <TextInput value={value} onChange={setValue} onSubmit={(text) => submitted.push(text)} />;
  }
  const ui = render(<Editor />);
  try {
    await ready(ui);
    ui.stdin.write("\x7f");
    await settle();
    ui.stdin.write("\x01");
    await settle();
    ui.stdin.write("!");
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(submitted, ["!hi "]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("palette filters punctuation, survives empty matches, and selects the intended row", async () => {
  let picked = "";
  const ui = render(
    <Navigator
      title="Commands"
      choices={[
        {
          id: "a",
          label: "Run history",
          select: () => {
            picked = "runs";
          },
        },
        {
          id: "b",
          label: "Fix CI tests",
          select: () => {
            picked = "ci";
          },
        },
      ]}
      onClose={() => {
        picked = "close";
      }}
    />,
  );
  try {
    await ready(ui);
    ui.stdin.write("fix-ci");
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.equal(picked, "ci");
    ui.stdin.write("zzz");
    await settle();
    assert.match(ui.lastFrame()!, /No matches/);
    ui.stdin.write("\x1b");
    await settle();
    assert.equal(picked, "close");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("reader wraps and reaches content beyond the old eight-line preview", async () => {
  const ui = render(
    <Reader
      title="Transcript"
      lines={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)}
      onClose={() => {}}
    />,
  );
  try {
    await ready(ui);
    ui.stdin.write("G");
    await settle();
    assert.match(ui.lastFrame()!, /line 100/);
    ui.stdin.write("g");
    await settle();
    assert.match(ui.lastFrame()!, /line 1\b/);
    assert.doesNotMatch(ui.lastFrame()!, /line 100/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("agent output cannot carry terminal commands, and long lines retain all text", () => {
  assert.equal(terminalText("safe\x1b[2J\x1b]52;c;ZXZpbA==\x07text"), "safetext");
  const input = "word ".repeat(100);
  assert.equal(wrapLines([input], 35).join(""), input);
});

test("search matches web issue identifiers with or without punctuation", () => {
  for (const query of ["eng441", "ENG-441", "eng 441", "eng - 441"])
    assert.equal(matchesSearch("Fix ENG-441: auth", query), true);
  assert.equal(matchesSearch("Fix ENG-441: auth", "eng442"), false);
});

test("long setup lists keep the selected item visible", async () => {
  const { SettingsRows, Row } = await import("./Setup.js");
  const ui = render(
    <SettingsRows>
      {Array.from({ length: 100 }, (_, i) => (
        <Row key={i} label={`Agent ${i}`} selected={i === 99} />
      ))}
    </SettingsRows>,
  );
  try {
    await ready(ui);
    assert.match(ui.lastFrame()!, /Agent 99/);
    assert.doesNotMatch(ui.lastFrame()!, /Agent 0\b/);
    assert.match(ui.lastFrame()!, /of 100/);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("exact menu names outrank incidental matches and Enter uses the displayed order", async () => {
  let chosen = "";
  const ui = render(
    <Navigator
      title="Authentication"
      choices={[
        {
          id: "none",
          label: "No authentication",
          select: () => {
            chosen = "none";
          },
        },
        {
          id: "oauth",
          label: "OAuth",
          select: () => {
            chosen = "oauth";
          },
        },
      ]}
      onClose={() => {}}
    />,
  );
  try {
    await ready(ui);
    ui.stdin.write("OAuth");
    await settle();
    assert.match(ui.lastFrame()!, /› OAuth/);
    ui.stdin.write("\r");
    await settle();
    assert.equal(chosen, "oauth");
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("replacing a wizard field moves the cursor to the new value's end", async () => {
  let replace = (_value: string) => {};
  const submitted: string[] = [];
  function Field() {
    const [value, setValue] = useState("grok-4.6");
    replace = setValue;
    return <TextInput value={value} onChange={setValue} onSubmit={(text) => submitted.push(text)} />;
  }
  const ui = render(<Field />);
  try {
    await ready(ui);
    replace("Cursor CLI");
    await settle();
    ui.stdin.write("\x15");
    await settle();
    ui.stdin.write("Reviewer");
    await settle();
    ui.stdin.write("\r");
    await settle();
    assert.deepEqual(submitted, ["Reviewer"]);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});

test("expanded prompt paging moves through wrapped paragraphs without jumping to the end", async () => {
  const original = "A long instruction with no line breaks. ".repeat(100);
  const submitted: string[] = [];
  function Editor() {
    const [value, setValue] = useState(original);
    return (
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => submitted.push(text)}
        multiline
        visibleRows={8}
        initialCursor="start"
      />
    );
  }
  const ui = render(<Editor />);
  try {
    await ready(ui);
    ui.stdin.write("\x1b[6~");
    await settle();
    ui.stdin.write("INSERTED");
    await settle();
    ui.stdin.write("\r");
    await settle();
    const result = submitted[0]!;
    assert.ok(result.indexOf("INSERTED") > 0);
    assert.ok(result.indexOf("INSERTED") < original.length / 2);
    assert.equal(result.replace("INSERTED", ""), original);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
