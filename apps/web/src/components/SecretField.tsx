import { useState } from "react";

/**
 * A field for a pasted credential, with its save button beside it.
 *
 * Two things people need here and did not have. Sight: a token is
 * pasted, not typed, and a masked field cannot tell you whether the
 * clipboard held what you thought, so the eye reveals it while the
 * page is yours to look at. And proximity: the button sat under the
 * field on its own line, which read as a separate step rather than as
 * the end of this one.
 */
export function SecretField({
  value,
  onChange,
  onSubmit,
  label,
  placeholder,
  submitLabel,
  busy = false,
  secret = true,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /** For screen readers, since the row carries no visible label of its own. */
  label: string;
  placeholder: string;
  submitLabel: string;
  busy?: boolean;
  /** False for values that are configuration rather than secrets, like a base URL. */
  secret?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <form
      className="secret-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSubmit();
      }}
    >
      <span className="secret-input">
        <input
          className="input"
          type={secret && !revealed ? "password" : "text"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          spellCheck={false}
          autoComplete="off"
        />
        {secret && (
          <button
            type="button"
            className="secret-reveal"
            onClick={() => setRevealed((on) => !on)}
            aria-pressed={revealed}
            aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
            title={revealed ? "Hide" : "Show"}
          >
            {revealed ? <EyeOff /> : <Eye />}
          </button>
        )}
      </span>
      <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
        {submitLabel}
      </button>
    </form>
  );
}

function Eye() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z" />
      <circle cx="10" cy="10" r="2.5" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M1.5 10S4.5 4.5 10 4.5c1.2 0 2.3.26 3.3.68M18.5 10s-1.4 2.56-4 4.05" />
      <path d="M8.2 8.2a2.5 2.5 0 0 0 3.5 3.5" />
      <path d="M3 3l14 14" />
    </svg>
  );
}
