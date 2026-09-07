import { useRef } from "react";
import { Box, Text, useInput } from "ink";

const DELETE_KEY = String.fromCharCode(127);
const BACKSPACE_KEY = String.fromCharCode(8);

/** Drops anything the terminal sends that is not text to display. */
function printable(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

/**
 * A single line of text the terminal can edit.
 *
 * Ink ships no input widget, and every prompt in setup needs the same
 * behaviour: type, backspace, submit, cancel.
 *
 * Two things make this trickier than it looks. Keystrokes arrive faster
 * than React re-renders, so submitting the `value` prop would send
 * whatever was on screen one render ago and silently drop the last thing
 * typed. And a paste arrives as one chunk with its newline attached, so
 * the text and the submit land in the same event.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  mask = false,
  placeholder = "",
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  /** Hides the characters, for secrets. */
  mask?: boolean;
  placeholder?: string;
}) {
  // Mirrors the prop so a burst of keystrokes composes correctly.
  const latest = useRef(value);
  latest.current = value;

  function edit(next: string) {
    latest.current = next;
    onChange(next);
  }

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    // Backspace arrives as DEL on macOS, which Ink does not always flag.
    if (key.backspace || key.delete || input === DELETE_KEY || input === BACKSPACE_KEY) {
      edit(latest.current.slice(0, -1));
      return;
    }
    const typed = printable(input);
    if (key.return) {
      // A pasted value carries its own newline, so keep the text and submit.
      const next = latest.current + typed;
      latest.current = next;
      onSubmit(next);
      return;
    }
    if (typed) edit(latest.current + typed);
  });

  const shown = mask ? "•".repeat(Math.min(value.length, 48)) : value;
  return (
    <Box>
      {value.length === 0 && placeholder ? (
        <Text color="gray">{placeholder}</Text>
      ) : (
        <Text color="cyan">{shown}</Text>
      )}
      <Text color="cyan">{"▊"}</Text>
    </Box>
  );
}
