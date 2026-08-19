import { useEffect, useState } from "react";
import { authClient, useSession } from "../auth-client.js";
import { teamDisplayName } from "../team-name.js";
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
 * The preview request's answers, as one value: still asking, a live
 * invitation, a dead one (404), or a request that failed. The last two
 * are deliberately distinct states: a deploy-window 502 told as "your
 * invitation is no longer valid" sends people asking for a reissue of
 * a link that was fine.
 */
type PreviewState = "loading" | "missing" | "failed" | InvitationPreview;

const MISSING_CODE_MESSAGE = "This link is missing its invitation code. Ask for a new invitation.";
const DEAD_INVITATION_MESSAGE =
  "This invitation is no longer valid. It may have expired, been cancelled, or been sent to a different email address.";
const LOOKUP_FAILED_MESSAGE = "Could not check this invitation just now. Check the connection, then try again.";

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
  const [preview, setPreview] = useState<PreviewState>("loading");
  /** Bumped by the Try again button; the preview effect keys on it. */
  const [attempt, setAttempt] = useState(0);
  const [social, setSocial] = useState<{ github: boolean; google: boolean } | undefined>(undefined);
  /**
   * Whether the session has ever resolved. Same latch as the console's:
   * the session hook goes pending again on every refetch, including the
   * one that follows signing up, and blanking the screen for those
   * unmounts SignIn and throws away the "confirm your email" step it
   * was showing.
   */
  const [sessionSettled, setSessionSettled] = useState(false);

  useEffect(() => {
    if (!isPending) setSessionSettled(true);
  }, [isPending]);

  // The preview is public and keyed by the URL alone, so it starts at
  // mount instead of waiting behind the session request: this page is
  // the first thing an invitee ever sees, and every serial round trip
  // here is a blank screen.
  useEffect(() => {
    if (!invitationId) return;
    let cancelled = false;
    setPreview("loading");
    void fetch(`/api/invitation-preview?id=${encodeURIComponent(invitationId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) setPreview((await res.json()) as InvitationPreview);
        else if (res.status === 404) setPreview("missing");
        else setPreview("failed");
      })
      .catch(() => {
        if (!cancelled) setPreview("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [invitationId, attempt]);

  // Which social logins exist, fetched here in parallel with the
  // preview rather than by SignIn after it, so the OAuth buttons do
  // not pop in a round trip late.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { social?: { github: boolean; google: boolean } } | null) => {
        if (!cancelled && body?.social) setSocial(body.social);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isPending || !session) return;
    // Only the first look. Accepting triggers a session refetch, which
    // reruns this effect against an invitation that is now spent, and
    // reading that 400 as "no longer valid" replaced the success screen
    // with an error about the invitation just accepted.
    if (phase !== "checking") return;
    if (!invitationId) {
      setPhase("error");
      setMessage(MISSING_CODE_MESSAGE);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await authClient.organization.getInvitation({ query: { id: invitationId } });
        if (cancelled) return;
        if (result.error) {
          setPhase("error");
          setMessage(DEAD_INVITATION_MESSAGE);
          return;
        }
        setOrganizationName((result.data as { organizationName?: string })?.organizationName ?? "the organization");
        setPhase("ready");
      } catch {
        // A thrown lookup is a connection problem, not a verdict on
        // the invitation, and must not strand the page on "checking".
        if (!cancelled) {
          setPhase("error");
          setMessage(LOOKUP_FAILED_MESSAGE);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPending, session, invitationId, phase]);

  if (isPending && !sessionSettled) return <div className="center" />;

  if (!session) {
    if (!invitationId) return <InvitationProblem message={MISSING_CODE_MESSAGE} />;
    if (preview === "loading") return <div className="center" />;
    if (preview === "missing") return <InvitationProblem message={DEAD_INVITATION_MESSAGE} />;
    if (preview === "failed") {
      return <InvitationProblem message={LOOKUP_FAILED_MESSAGE} onRetry={() => setAttempt((n) => n + 1)} />;
    }
    return (
      <SignIn
        social={social}
        initialMode={preview.userExists ? "in" : "up"}
        initialEmail={preview.email}
        // The invitation is only acceptable by the invited address, so
        // an edited or autofilled other address could only end in a
        // refusal after the account already exists.
        lockEmail
        callbackURL={`/accept-invitation?id=${encodeURIComponent(invitationId)}`}
        note={`You were invited to join "${teamDisplayName(preview.organizationName)}".`}
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

  if (phase === "error") {
    return (
      <InvitationProblem
        message={message}
        onRetry={message === LOOKUP_FAILED_MESSAGE ? () => setPhase("checking") : undefined}
      />
    );
  }

  return (
    <div className="center">
      <div className="card-panel card-panel-centered">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Join {teamDisplayName(organizationName)}</h1>
        </div>

        {phase === "checking" && <p className="muted">Checking the invitation...</p>}

        {(phase === "ready" || phase === "accepting") && (
          <>
            <p className="muted">You were invited to work on this team's boards.</p>
            <div className="actions actions-centered">
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

        {phase === "declined" && (
          <>
            <p className="muted">Declined. Nothing was shared with you.</p>
            <div className="actions actions-centered">
              <a className="btn" href="/">
                Open Bento
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The dead ends, in the same card the rest of the page uses, with a way
 * out: a person whose invitation is spent may still hold an account and
 * a board here, and a card with no doors strands them.
 */
function InvitationProblem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="center">
      <div className="card-panel card-panel-centered">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Join a team</h1>
        </div>
        <p className="error">{message}</p>
        <div className="actions actions-centered">
          {onRetry && (
            <button className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          )}
          <a className="btn" href="/">
            Open Bento
          </a>
        </div>
      </div>
    </div>
  );
}
