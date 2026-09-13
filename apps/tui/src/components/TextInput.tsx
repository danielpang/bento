import { useKeyboardInput as useInput } from "../mouse.js";
import { useRef, useState } from "react";
import { Box, Text, useStdin, usePaste, useWindowSize } from "ink";
import { terminalText } from "../terminal.js";
import stringWidth from "string-width";
import { useMouseTarget } from "../mouse.js";
import { MouseActions, MouseButton } from "./MouseControls.js";
import { type ClipboardContent } from "../clipboard.js";

// Keep tabs in the draft, but render one visible cell instead of letting the
// terminal advance its cursor outside Ink's layout and break mouse targets.
const displayTabs = (text: string) => text.replace(/\t/g, "⇥");

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
    const cells = stringWidth(displayTabs(segment));
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

function editorLineStarts(text: string, width: number) {
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
    const cells = stringWidth(displayTabs(segment));
    if (x + cells > width) {
      starts.push(index);
      x = 0;
    }
    x += cells;
    index += length;
  }
  if (x >= width) starts.push(index);
  return starts;
}

/** Keep the caret and form buttons visible even when a paste contains many short lines. */
export function editorWindow(text: string, cursor: number, width: number, height: number, anchor?: number) {
  const starts = editorLineStarts(text, width);
  const index = Array.from(text).length;
  const line = Math.max(
    0,
    starts.findLastIndex((start) => start <= cursor),
  );
  const preferred = anchor === undefined ? 0 : starts.findLastIndex((start) => start <= anchor);
  const first = Math.max(0, Math.min(preferred, line, starts.length - height), line - height + 1);
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
  visibleRows,
  initialCursor = "end",
  onFocus,
  onPasteContent,
  onClipboardError,
  onPastePending,
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
  /** A dedicated editor can use the available screen instead of the inline four-line window. */
  visibleRows?: number;
  initialCursor?: "start" | "end";
  onFocus?: () => void;
  onPasteContent?: (content: ClipboardContent) => Promise<boolean>;
  onClipboardError?: (message: string) => void;
  onPastePending?: (pending: boolean) => void;
}) {
  const { isRawModeSupported } = useStdin();
  const { columns, rows } = useWindowSize();
  const latest = useRef(value);
  const position = useRef(initialCursor === "start" ? 0 : Array.from(value).length);
  const windowStart = useRef(0);
  const [cursor, setCursor] = useState(position.current);
  const [clipboardError, setClipboardError] = useState("");
  const clipboardBusy = useRef(0);
  if (latest.current !== value) {
    latest.current = value;
    // A different controlled value opens a new draft or wizard field.
    // Local edits already updated latest, so their cursor stays intact.
    position.current = Array.from(value).length;
    setCursor(position.current);
  }
  const active = isActive && isRawModeSupported === true;
  const windowHeight = multiline ? Math.max(1, visibleRows ?? Math.min(4, rows - 10)) : 1;
  const width = Math.max(10, columns - 10);
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
  function moveLines(direction: number, count = 1) {
    const chars = Array.from(latest.current);
    let at = position.current;
    if (visibleRows !== undefined) {
      const starts = editorLineStarts(latest.current, width - 2);
      const line = Math.max(
        0,
        starts.findLastIndex((start) => start <= at),
      );
      const target = Math.max(0, Math.min(starts.length - 1, line + direction * count));
      const column = stringWidth(displayTabs(chars.slice(starts[line], at).join("")));
      const targetText = chars
        .slice(starts[target], starts[target + 1] ?? chars.length)
        .join("")
        .replace(/\n$/, "");
      move(starts[target]! + cursorAtCell(targetText, width - 2, column, 0));
      return;
    }
    for (let i = 0; i < count; i++) {
      const start = at === 0 ? 0 : chars.lastIndexOf("\n", at - 1) + 1;
      const column = at - start;
      if (direction < 0) {
        if (start === 0) {
          at = 0;
          break;
        }
        const previousStart = start < 2 ? 0 : chars.lastIndexOf("\n", start - 2) + 1;
        at = Math.min(start - 1, previousStart + column);
      } else {
        const next = chars.indexOf("\n", at);
        if (next === -1) {
          at = chars.length;
          break;
        }
        const end = chars.indexOf("\n", next + 1);
        at = Math.min(end === -1 ? chars.length : end, next + 1 + column);
      }
    }
    move(at);
  }
  const reportClipboardError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (onClipboardError) onClipboardError(message);
    else setClipboardError(message);
  };
  async function pasteContent(content: ClipboardContent) {
    if (onPasteContent && (await onPasteContent(content))) return;
    if (content.text !== undefined) insert(content.text);
    else if (content.files) insert(content.files.join("\n"));
    else throw new Error("This field accepts text. Use the conversation editor to attach images.");
  }
  usePaste(
    (text) => {
      clipboardBusy.current++;
      onPastePending?.(true);
      void pasteContent({ text })
        .catch(reportClipboardError)
        .finally(() => {
          clipboardBusy.current--;
          onPastePending?.(clipboardBusy.current > 0);
        });
    },
    { isActive: active },
  );
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
        moveLines(key.upArrow ? -1 : 1);
        return;
      }
      if (multiline && (key.pageUp || key.pageDown)) {
        moveLines(key.pageUp ? -1 : 1, windowHeight);
        windowStart.current = position.current;
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
        if (clipboardBusy.current) return;
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

  const chars = Array.from(mask ? "•".repeat(Array.from(value).length) : displayTabs(value));
  const at = Math.min(cursor, chars.length);
  const { start, end } = editorWindow(
    chars.join(""),
    at,
    width - 2,
    windowHeight,
    visibleRows === undefined ? undefined : windowStart.current,
  );
  windowStart.current = start;
  const before = chars.slice(start, at).join("");
  const after = `${chars[at] === "\n" ? "\n" : ""}${chars.slice(at + 1, end).join("")}`;
  const displayed = `${start > 0 ? "…" : ""}${before}${chars[at] === "\n" ? " " : (chars[at] ?? " ")}${after}`;
  const mouse = useMouseTarget(
    {
      priority: 2,
      onClick: (event) => {
        onFocus?.();
        let next = start + cursorAtCell(displayed, event.width, event.column, event.row) - Number(start > 0);
        if (chars[at] === "\n" && next > at) next--;
        move(Math.max(0, Math.min(chars.length, next)));
      },
      onScroll: (event) => {
        if (!multiline || !active) return;
        if (event.kind === "up" || event.kind === "down")
          move(
            Math.max(0, Math.min(chars.length, position.current + (event.kind === "up" ? -width : width))),
          );
      },
    },
    active || (onFocus !== undefined && isRawModeSupported === true),
  );
  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      <Box
        ref={mouse}
        {...(visibleRows !== undefined ? { height: windowHeight, overflow: "hidden" as const } : {})}
      >
        <Text color="cyan" wrap="hard">
          {start > 0 ? "…" : ""}
          {before}
          <Text inverse={active}>{chars[at] === "\n" ? " " : (chars[at] ?? " ")}</Text>
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
      {clipboardError && (
        <Text color="yellow" wrap="truncate-end">
          {clipboardError}
        </Text>
      )}
    </Box>
  );
}
