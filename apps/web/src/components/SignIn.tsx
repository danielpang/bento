import { useEffect, useState, type FormEvent } from "react";
import { authClient, signIn, signUp } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";
import { GitHubIcon, GoogleIcon } from "./ProviderIcons.js";

/**
 * Which social logins to offer.
 *
 * Asked here when the caller does not already know, because this page
 * is reached from four places: the console, the settings page, the
 * invitation link, and the device approval page. Two of those rendered
 * it with no answer, and a gate that reads "unknown" as "none" left an
 * invited teammate who signed up with GitHub no way in at all.
 */
function useSocialProviders(supplied?: { github: boolean; google: boolean }) {
  const [discovered, setDiscovered] = useState<{ github: boolean; google: boolean } | undefined>(undefined);
  useEffect(() => {
    if (supplied) return;
    void fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { social?: { github: boolean; google: boolean } } | null) => {
        if (body?.social) setDiscovered(body.social);
      })
      .catch(() => setDiscovered(undefined));
  }, [supplied]);
  return supplied ?? discovered;
}

export function SignIn({
  social: supplied,
  initialMode = "in",
  initialEmail = "",
  callbackURL = "/",
  note,
}: {
  social?: { github: boolean; google: boolean };
  /** Open on sign up instead: the invitation page knows the invitee has no account yet. */
  initialMode?: "in" | "up";
  initialEmail?: string;
  /**
   * Where to land once the account works. Sign up can detour through a
   * verification email or an OAuth provider, and both come back to this
   * address rather than the board: an invitee who lost their invitation
   * on the way was asked to create a team instead of joining one.
   */
  callbackURL?: string;
  /** Replaces the tagline, so the invitation page can say whose team this is. */
  note?: string;
}) {
  const social = useSocialProviders(supplied);
  const [mode, setMode] = useState<"in" | "up">(initialMode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Set once an address needs confirming, which is not an error to fix but a step to finish. */
  const [pendingEmail, setPendingEmail] = useState("");
  const [notice, setNotice] = useState("");
  const [forgot, setForgot] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const result =
      mode === "in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email, callbackURL });
    setBusy(false);
    if (!result.error) {
      // Signing up no longer signs you in: the address has to be
      // confirmed first, so say so rather than leaving a form that
      // looks like it did nothing.
      if (mode === "up") setPendingEmail(email);
      return;
    }
    // An unconfirmed address is the one failure with a next step
    // attached, so it gets its own screen instead of a red line.
    const message = result.error.message ?? "";
    if (result.error.status === 403 || /verif/i.test(message)) {
      setPendingEmail(email);
      return;
    }
    setError(message || "Sign in failed. Check your details and try again.");
  }

  async function resend() {
    setBusy(true);
    setNotice("");
    try {
      await authClient.sendVerificationEmail({ email: pendingEmail, callbackURL });
      setNotice("Sent. Check your inbox again, including the spam folder.");
    } catch {
      setNotice("Could not send it just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    // The same answer either way: whether an address has an account is
    // not something a sign-in form should disclose.
    setNotice(
      result.error
        ? "Could not send the email just now. Try again in a moment."
        : "If that address has an account, a reset link is on its way.",
    );
  }

  if (pendingEmail) {
    return (
      <div className="center">
        <div className="card-panel">
          <div className="auth-head">
            <BrandLockup size="lg" />
            <h1>Confirm your email</h1>
          </div>
          <p className="muted">
            We sent a link to <strong>{pendingEmail}</strong>. Open it and you land straight on your
            board. Accounts stay locked until the address is confirmed.
          </p>
          {notice && <p className="muted">{notice}</p>}
          <button className="btn btn-block" disabled={busy} onClick={() => void resend()}>
            {busy ? "Sending..." : "Send it again"}
          </button>
          <p className="auth-foot">
            <button
              className="btn-link"
              onClick={() => {
                setPendingEmail("");
                setNotice("");
                setMode("in");
              }}
            >
              Back to sign in
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (forgot) {
    return (
      <div className="center">
        <div className="card-panel">
          <div className="auth-head">
            <BrandLockup size="lg" />
            <h1>Reset your password</h1>
          </div>
          <p className="muted">Give us the address on the account and we will send a link to choose a new password.</p>
          <form onSubmit={requestReset} className="section">
            <label className="field">
              <span className="label">Email</span>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
            {notice && <p className="muted">{notice}</p>}
            <button className="btn btn-primary btn-block" type="submit" disabled={busy || !email}>
              {busy ? "Sending..." : "Send the link"}
            </button>
          </form>
          <p className="auth-foot">
            <button className="btn-link" onClick={() => { setForgot(false); setNotice(""); }}>
              Back to sign in
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="card-panel">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>{mode === "in" ? "Sign in" : "Create an account"}</h1>
          {/* The product's own rule, not a value proposition. A line
              a maintainer would write beats a line a marketing page
              would. */}
          <p className="muted">{note ?? "One card, one agent, one branch."}</p>
        </div>

        {/* Only providers the server actually has credentials for: a
            button whose flow can only 404 teaches distrust on the very
            first screen. */}
        {(social?.github || social?.google) && (
          <>
            <div className="auth-social">
              {social.github && (
                <button className="btn btn-block" onClick={() => signIn.social({ provider: "github", callbackURL })}>
                  <GitHubIcon />
                  Continue with GitHub
                </button>
              )}
              {social.google && (
                <button className="btn btn-block" onClick={() => signIn.social({ provider: "google", callbackURL })}>
                  <GoogleIcon />
                  Continue with Google
                </button>
              )}
            </div>
            <div className="divider">Or</div>
          </>
        )}

        <form onSubmit={submit} className="section">
          {mode === "up" && (
            <label className="field">
              <span className="label">Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span className="label">Email</span>
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="field">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "Working..." : mode === "in" ? "Sign in" : "Create an account"}
          </button>
        </form>

        <div className="auth-foot">
          <p>
            {mode === "in" ? "New here? " : "Already have an account? "}
            <button className="btn-link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
              {mode === "in" ? "Create an account" : "Sign in"}
            </button>
          </p>
          {mode === "in" && (
            <p>
              <button className="btn-link" onClick={() => { setForgot(true); setError(""); }}>
                Forgot your password?
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
