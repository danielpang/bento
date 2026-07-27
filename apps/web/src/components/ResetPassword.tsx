import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";

/**
 * The other end of the reset email.
 *
 * A page rather than a dialog, because the person arrives here from
 * their inbox with no session and nothing else on screen. The token is
 * in the address; an absent or spent one is a dead end unless the page
 * says so and offers the way back, which is asking for a fresh link.
 */
export function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (result.error) {
      setError(
        result.error.message ??
          "That link is no longer valid. Ask for a new one from the sign in page.",
      );
      return;
    }
    setDone(true);
  }

  return (
    <div className="center">
      <div className="card-panel">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Choose a new password</h1>
        </div>

        {!token ? (
          <>
            <p className="error">This link is missing its token, so it cannot reset anything.</p>
            <a className="btn btn-primary" href="/">
              Back to sign in
            </a>
          </>
        ) : done ? (
          <>
            <p className="muted">Your password is changed. Sign in with it now.</p>
            <a className="btn btn-primary" href="/">
              Go to sign in
            </a>
          </>
        ) : (
          <form onSubmit={submit} className="section">
            <label className="field">
              <span className="label">New password</span>
              <input
                className="input"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
              <span className="muted">At least 8 characters.</span>
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn btn-primary" type="submit" disabled={busy || password.length < 8}>
              {busy ? "Saving..." : "Save the password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
