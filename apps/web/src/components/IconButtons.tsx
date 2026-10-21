export function StopButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn composer-stop icon-button"
      disabled={disabled}
      title="Stop the agent"
      aria-label="Stop the agent"
      onClick={onClick}
    >
      <span className="stop-square" aria-hidden="true" />
    </button>
  );
}

/**
 * Stops the turn the agent is on and keeps the session open, so the
 * next message redirects it. A pause mark, beside Stop's square, so the
 * two read as "stop this" and "stop everything".
 */
export function InterruptButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn composer-interrupt icon-button"
      disabled={disabled}
      title="Interrupt this turn. The agent waits for your next message."
      aria-label="Interrupt this turn"
      onClick={onClick}
    >
      <span className="pause-bars" aria-hidden="true" />
    </button>
  );
}

export function SignOutButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost icon-button"
      title="Sign out"
      aria-label="Sign out"
      onClick={onClick}
    >
      <svg className="signout-mark" viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" focusable="false">
        <path d="M6.5 2.5H3.75v11H6.5M9.25 5l3 3-3 3M12 8H6.25" />
      </svg>
    </button>
  );
}

/** Rename, sat beside the name it renames rather than in a button row. */
export function RenameButton({
  label,
  disabled,
  onClick,
}: {
  /** Names the target, since the icon alone says "rename" but not what. */
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost icon-button name-edit"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg className="pencil-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M11.6 2.6a1.4 1.4 0 0 1 2 2L6.4 11.8l-2.6.8.8-2.6z" />
        <path d="M10.3 3.9l1.8 1.8" />
      </svg>
    </button>
  );
}
