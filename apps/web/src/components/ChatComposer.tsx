import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { StopButton } from "./IconButtons.js";

/**
 * How tall the composer may grow, in pixels, before it scrolls.
 * Long enough to read a wrapped paragraph, short enough that it
 * cannot eat the transcript above it.
 */
export const COMPOSER_MAX_HEIGHT = 160;

/**
 * A long line used to vanish into a one-line field. Height is reset
 * before it is measured, or the box could only ever grow; past the
 * cap it scrolls rather than pushing the transcript off the screen.
 */
export function growComposer(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  const content = el.scrollHeight;
  el.style.height = `${Math.min(content, COMPOSER_MAX_HEIGHT)}px`;
  el.style.overflowY = content > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}

export function SendMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 13.25V3.25" />
      <path d="M3.75 7.5 8 3.25 12.25 7.5" />
    </svg>
  );
}

/**
 * The one-line composer the card conversation uses: the field, Stop
 * beside it while the agent works, and Send. Enter sends, Shift+Enter
 * is the newline, and the field grows with the text up to a cap.
 *
 * Shared with the swarm board so a planner's and a worker's
 * conversation read exactly like a card's.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  placeholder,
  ariaLabel,
  disabled = false,
  busy = false,
  id,
  maxLength,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  /** Present while an agent is working: shows Stop beside the field. */
  onStop?: (() => void) | undefined;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  busy?: boolean;
  id?: string;
  /** The server's own cap on a message, so the field refuses what the route would. */
  maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    growComposer(ref.current);
  }, [value]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || busy || !value.trim()) return;
    onSend();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (disabled || busy || !value.trim()) return;
      onSend();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={ref}
        id={id}
        className="input composer-input"
        rows={1}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || busy}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
      />
      {onStop && <StopButton disabled={busy} onClick={onStop} />}
      <button
        className="btn btn-primary composer-send"
        type="submit"
        disabled={disabled || busy || !value.trim()}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <SendMark />
      </button>
    </form>
  );
}
