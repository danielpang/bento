import { useEffect, useState } from "react";
import { authClient } from "../auth-client.js";
import { useSession } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";
import { SignIn } from "./SignIn.js";

type Phase = "entering" | "claiming" | "ready" | "done" | "denied" | "error";

/**
 * Browser side of the terminal login. The user reads a code from their
 * terminal and confirms it here.
 *
 * Order matters: better-auth requires the code to be claimed by a signed
 * in session (GET /device?user_code=...) before approve or deny will be
 * accepted, so this page always verifies first.
 */
export function DeviceApproval() {
  const initial = new URLSearchParams(window.location.search).get("user_code") ?? "";
  const [code, setCode] = useState(initial);
  const [phase, setPhase] = useState<Phase>("entering");
  const [message, setMessage] = useState("");
  const [deciding, setDeciding] = useState(false);
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (initial && session) void claim(initial);
    // Claiming runs once for a code supplied in the URL, and only once
    // signed in: unauthenticated claims fail and would misreport a
    // valid code as expired.
  }, [session?.session.id]);

  async function claim(userCode: string) {
    setPhase("claiming");
    setMessage("");
    const res = await fetch(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
      credentials: "include",
    });
    if (!res.ok) {
      setPhase("error");
      setMessage("That code is not valid. It may have expired, so start the login again in your terminal.");
      return;
    }
    setPhase("ready");
  }

  async function decide(approve: boolean) {
    setDeciding(true);
    try {
      const result = approve
        ? await authClient.device.approve({ userCode: code })
        : await authClient.device.deny({ userCode: code });
      if (result.error) {
        setPhase("error");
        setMessage(explain(result.error.error));
        return;
      }
      setPhase(approve ? "done" : "denied");
    } finally {
      setDeciding(false);
    }
  }

  if (isPending) return <div className="center" />;
  if (!session) return <SignIn />;

  return (
    <div className="center">
      <div className="card-panel">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Connect a terminal</h1>
        </div>

        {phase === "entering" || phase === "claiming" || phase === "error" ? (
          <>
            {phase === "error" && <p className="error">{message}</p>}
            <p className="muted">Enter the code shown in your terminal.</p>
            <input
              className="input user-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD1234"
              aria-label="Device code"
            />
            <button className="btn btn-primary" disabled={!code || phase === "claiming"} onClick={() => claim(code)}>
              {phase === "claiming" ? "Checking..." : "Continue"}
            </button>
          </>
        ) : null}

        {phase === "ready" && (
          <>
            <p className="muted">A terminal is asking to sign in as you.</p>
            <div className="user-code">{code}</div>
            <div className="actions">
              <button className="btn btn-primary" disabled={deciding} onClick={() => decide(true)}>
                Approve
              </button>
              <button className="btn" disabled={deciding} onClick={() => decide(false)}>
                Deny
              </button>
            </div>
          </>
        )}

        {phase === "done" && <p className="muted">Approved. Return to your terminal, it will continue on its own.</p>}
        {phase === "denied" && <p className="muted">Denied. The terminal will not be signed in.</p>}
      </div>
    </div>
  );
}

/** Turns the plugin's OAuth error codes into something actionable. */
function explain(code: string): string {
  switch (code) {
    case "expired_token":
      return "That code expired. Start the login again in your terminal to get a new one.";
    case "device_code_already_processed":
      return "That code was already used. Start the login again in your terminal.";
    case "unauthorized":
      return "This code belongs to a different account. Sign in as the account that started the login.";
    case "invalid_request":
      return "That code is not valid. Check the characters and try again.";
    default:
      return "Could not record your answer. Try again.";
  }
}
