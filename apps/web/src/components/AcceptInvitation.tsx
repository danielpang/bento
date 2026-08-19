import { useEffect, useState } from "react";
import { authClient, useSession } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";
import { SignIn } from "./SignIn.js";

type Phase = "checking" | "ready" | "accepting" | "accepted" | "declined" | "error";

/**
 * Who an invitation is for, readable before sign in.
 *
 * better-auth's own get-invitation needs a session, which is exactly
 * what a new invitee does not have, so the server exposes this much
 * against the invitation id alone. userExists is what decides whether
 * the page opens on sign up or sign in.
 */
interface InvitationPreview {
  email: string;
  organizationName: string;
  userExists: boolean;
}

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
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewChecked, setPreviewChecked] = useState(false);

  useEffect(() => {
    if (isPending || !session) return;
    // Only the first look. Accepting triggers a session refetch, which
    // reruns this effect against an invitation that is now spent, and
    // reading that 400 as "no longer valid" replaced the success screen
    // with an error about the invitation just accepted.
    if (phase !== "checking") return;
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
  }, [isPending, session, invitationId, phase]);

  useEffect(() => {
    if (isPending || session || !invitationId) return;
    void fetch(`/api/invitation-preview?id=${encodeURIComponent(invitationId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<InvitationPreview>) : null))
      .then((body) => setPreview(body))
      .catch(() => setPreview(null))
      .finally(() => setPreviewChecked(true));
  }, [isPending, session, invitationId]);

  if (isPending) return <div className="center" />;
  if (!session) {
    if (!invitationId) {
      return <InvitationProblem message="This link is missing its invitation code. Ask for a new invitation." />;
    }
    if (!previewChecked) return <div className="center" />;
    // A dead link is told apart here, not after a sign in that could
    // only end on the same message.
    if (!preview) {
      return (
        <InvitationProblem message="This invitation is no longer valid. It may have expired, been cancelled, or been sent to a different email address." />
      );
    }
    return (
      <SignIn
        initialMode={preview.userExists ? "in" : "up"}
        initialEmail={preview.email}
        callbackURL={`/accept-invitation?id=${encodeURIComponent(invitationId)}`}
        note={`You were invited to join ${preview.organizationName}.`}
      />
    );
  }

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
      <div className="card-panel card-panel-centered">
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

/** The signed-out dead ends, in the same card the rest of the page uses. */
function InvitationProblem({ message }: { message: string }) {
  return (
    <div className="center">
      <div className="card-panel card-panel-centered">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Join a team</h1>
        </div>
        <p className="error">{message}</p>
      </div>
    </div>
  );
}
