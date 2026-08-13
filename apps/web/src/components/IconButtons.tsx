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
