import { useKeyboardInput as useInput } from "../mouse.js";
import { useRef, useState } from "react";
import { Box, Text, useStdin, usePaste, useWindowSize } from "ink";
import { terminalText } from "../terminal.js";
import stringWidth from "string-width";
import { useMouseTarget } from "../mouse.js";
import { MouseActions, MouseButton } from "./MouseControls.js";

/** Map display cells back to code-point offsets, including wide glyphs and combining marks. */
export function cursorAtCell(text: string, width: number, column: number, row: number): number {
  let x = 0,
    y = 0,
    index = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (segment === "\n") {
      if (y === row) return index;
      y++;
      x = 0;
      index++;
      continue;
    }
    const cells = stringWidth(segment);
    if (x + cells > width) {
      y++;
      x = 0;
    }
    if (y > row || (y === row && column < x + cells)) return index;
    x += cells;
    index += Array.from(segment).length;
  }
  return index;
}

/** Keep the caret and form buttons visible even when a paste contains many short lines. */
export function editorWindow(text: string, cursor: number, width: number, height: number) {
  const starts = [0];
  let x = 0,
    index = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const length = Array.from(segment).length;
    if (segment === "\n") {
      index += length;
      starts.push(index);
      x = 0;
      continue;
    }
    const cells = stringWidth(segment);
    if (x + cells > width) {
      starts.push(index);
      x = 0;
    }
    x += cells;
    index += length;
  }
  if (x >= width) starts.push(index);
  const line = Math.max(
    0,
    starts.findLastIndex((start) => start <= cursor),
  );
  const first = Math.max(0, line - height + 1);
  const start = starts[first]!;
  let end = starts[first + height] ?? index;
  if (end > cursor && Array.from(text)[end - 1] === "\n") end--;
  return { start, end };
}

/** Shared editor. Pasting never submits a form or executes a board shortcut. */
export function TextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  mask = false,
  placeholder = "",
  multiline = false,
  isActive = true,
  showActions = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  mask?: boolean;
  placeholder?: string;
  multiline?: boolean;
  isActive?: boolean;
  showActions?: boolean;
}) {
  const { isRawModeSupported } = useStdin();
  const { columns, rows } = useWindowSize();
  const latest = useRef(value);
  const position = useRef(Array.from(value).length);
  const [cursor, setCursor] = useState(position.current);
  if (latest.current !== value) {
    latest.current = value;
    // A different controlled value opens a new draft or wizard field.
    // Local edits already updated latest, so their cursor stays intact.
    position.current = Array.from(value).length;
    setCursor(position.current);
  }
  const active = isActive && isRawModeSupported === true;
  function move(next: number) {
    position.current = next;
    setCursor(next);
  }
  function edit(chars: string[], next: number) {
    latest.current = chars.join("");
    move(next);
    onChange(latest.current);
  }
  function insert(input: string) {
    const text = terminalText(input).replace(/\r\n?/g, "\n");
    const chars = Array.from(latest.current);
    const added = Array.from(multiline ? text : text.replace(/\n/g, " "));
    chars.splice(position.current, 0, ...added);
    edit(chars, position.current + added.length);
  }
  usePaste(insert, { isActive: active });
  useInput(
    (input, key) => {
      const chars = Array.from(latest.current);
      const at = position.current;
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.leftArrow) {
        move(Math.max(0, at - 1));
        return;
      }
      if (key.rightArrow) {
        move(Math.min(chars.length, at + 1));
        return;
      }
      if (multiline && (key.upArrow || key.downArrow)) {
        const before = chars.slice(0, at).join("");
        const lineStart = before.lastIndexOf("\n") + 1;
        const column = Array.from(before.slice(lineStart)).length;
        const start = Array.from(before.slice(0, lineStart)).length;
        if (key.upArrow && start > 0) {
          const previous = chars.slice(0, start - 1);
          const previousStart = previous.lastIndexOf("\n") + 1;
          move(Math.min(start - 1, previousStart + column));
        } else if (key.downArrow) {
          const next = chars.indexOf("\n", at);
          if (next !== -1) {
            const end = chars.indexOf("\n", next + 1);
            move(Math.min(end === -1 ? chars.length : end, next + 1 + column));
          }
        }
        return;
      }
      if (key.home || (key.ctrl && input === "a")) {
        move(0);
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        move(chars.length);
        return;
      }
      if (key.ctrl && input === "u") {
        edit(chars.slice(at), 0);
        return;
      }
      if (key.ctrl && input === "k") {
        edit(chars.slice(0, at), at);
        return;
      }
      if (key.ctrl && input === "w") {
        const before = chars
          .slice(0, at)
          .join("")
          .replace(/\s*\S+\s*$/, "");
        edit([...Array.from(before), ...chars.slice(at)], Array.from(before).length);
        return;
      }
      if (key.return && input.length <= 1) {
        if (multiline && (key.shift || key.meta)) insert("\n");
        else onSubmit(latest.current);
        return;
      }
      if (multiline && key.ctrl && input === "j") {
        insert("\n");
        return;
      }
      if (key.backspace || input === "\x7f" || input === "\b") {
        if (at > 0) {
          chars.splice(at - 1, 1);
          edit(chars, at - 1);
        }
        return;
      }
      if (key.delete) {
        chars.splice(at, 1);
        edit(chars, at);
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown)
        return;
      if (input) insert(input);
    },
    { isActive: active },
  );

  const chars = Array.from(mask ? "•".repeat(Array.from(value).length) : value);
  const at = Math.min(cursor, chars.length);
  const width = Math.max(10, columns - 10);
  const { start, end } = editorWindow(
    chars.join(""),
    at,
    width - 2,
    multiline ? Math.max(1, Math.min(4, rows - 10)) : 1,
  );
  const before = chars.slice(start, at).join("");
  const after = `${chars[at] === "\n" ? "\n" : ""}${chars.slice(at + 1, end).join("")}`;
  const displayed = `${start > 0 ? "…" : ""}${before}${chars[at] === "\n" ? " " : (chars[at] ?? " ")}${after}`;
  const mouse = useMouseTarget(
    {
      priority: 2,
      onClick: (event) => {
        let next = start + cursorAtCell(displayed, event.width, event.column, event.row) - Number(start > 0);
        if (chars[at] === "\n" && next > at) next--;
        move(Math.max(0, Math.min(chars.length, next)));
      },
      onScroll: (event) => {
        if (!multiline) return;
        if (event.kind === "up" || event.kind === "down")
          move(
            Math.max(0, Math.min(chars.length, position.current + (event.kind === "up" ? -width : width))),
          );
      },
    },
    active,
  );
  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      <Box ref={mouse}>
        <Text color="cyan" wrap="hard">
          {start > 0 ? "…" : ""}
          {before}
          <Text inverse>{chars[at] === "\n" ? " " : (chars[at] ?? " ")}</Text>
          {after}
        </Text>
        {!value && <Text dimColor>{placeholder}</Text>}
      </Box>
      {showActions && (
        <MouseActions>
          <MouseButton label="Submit" onClick={() => onSubmit(latest.current)} disabled={!active} />
          {onCancel && <MouseButton label="Cancel" onClick={onCancel} disabled={!active} />}
        </MouseActions>
      )}
    </Box>
  );
}
