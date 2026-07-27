import { useEffect, useState } from "react";
import { authClient, useSession } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";
import { SignIn } from "./SignIn.js";

type Phase = "checking" | "ready" | "accepting" | "accepted" | "declined" | "error";

/**
 * Landing page for the link in an invitation email.
 *
 * Accepting requires a signed-in account, so an invitee who is new signs
 * up first and lands back here with the invitation still pending.
 */
export function AcceptInvitation() {
  const { data: session, isPending } = useSession();
  const invitationId = new URLSearchParams(window.location.search).get("id") ?? "";
  const [phase, setPhase] = useState<Phase>("checking");
  const [organizationName, setOrganizationName] = useState("this team");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (isPending || !session) return;
    if (!invitationId) {
      setPhase("error");
      setMessage("This link is missing its invitation code. Ask for a new invitation.");
      return;
    }
    void (async () => {
      const result = await authClient.organization.getInvitation({ query: { id: invitationId } });
      if (result.error) {
        setPhase("error");
        setMessage(
          "This invitation is no longer valid. It may have expired, been cancelled, or been sent to a different email address.",
        );
        return;
      }
      setOrganizationName((result.data as { organizationName?: string })?.organizationName ?? "the organization");
      setPhase("ready");
    })();
  }, [isPending, session, invitationId]);

  if (isPending) return <div className="center" />;
  if (!session) return <SignIn />;

  async function decide(accept: boolean) {
    setPhase("accepting");
    const result = accept
      ? await authClient.organization.acceptInvitation({ invitationId })
      : await authClient.organization.rejectInvitation({ invitationId });
    if (result.error) {
      setPhase("error");
      setMessage(result.error.message ?? "That did not work. Ask for a new invitation.");
      return;
    }
    if (!accept) {
      setPhase("declined");
      return;
    }
    // Land the new member on the board they just joined.
    const orgId = (result.data as { invitation?: { organizationId?: string } })?.invitation?.organizationId;
    if (orgId) await authClient.organization.setActive({ organizationId: orgId });
    setPhase("accepted");
  }

  return (
    <div className="center">
      <div className="card-panel">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Join {organizationName}</h1>
        </div>

        {phase === "checking" && <p className="muted">Checking the invitation...</p>}

        {(phase === "ready" || phase === "accepting") && (
          <>
            <p className="muted">You were invited to work on this team's boards.</p>
            <div className="actions">
              <button className="btn btn-primary" disabled={phase === "accepting"} onClick={() => decide(true)}>
                {phase === "accepting" ? "Joining..." : "Accept"}
              </button>
              <button className="btn" disabled={phase === "accepting"} onClick={() => decide(false)}>
                Decline
              </button>
            </div>
          </>
        )}

        {phase === "accepted" && (
          <>
            <p className="muted">You are in. Open the board to see what the team is building.</p>
            <button className="btn btn-primary" onClick={() => (window.location.href = "/")}>
              Go to the board
            </button>
          </>
        )}

        {phase === "declined" && <p className="muted">Declined. Nothing was shared with you.</p>}
        {phase === "error" && <p className="error">{message}</p>}
      </div>
    </div>
  );
}
