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
const ACTION_FAILED_MESSAGE = "Could not finish that just now. Check the connection, then try again.";

/** better-auth's answer when the session's address is not the invited one. */
const NOT_THE_RECIPIENT = "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION";

/**
 * A dead end, and what can be done about it.
 *
 * The affordances ride here as flags. They used to be inferred by
 * comparing the message against the copy constant above, which made a
 * user facing sentence into control flow: rewording it would have
 * silently removed the retry button, and any error whose text happened
 * to match would have grown one.
 */
interface Problem {
  message: string;
  /** A failure that may not repeat, as opposed to a verdict on the invitation. */
  canRetry?: boolean;
  /** Signed in as somebody this invitation is not for, so offer the way out. */
  canSignOut?: boolean;
}

/**
 * What went wrong, told apart by code and status rather than by the
 * sentence better-auth wrote.
 *
 * The client answers with { error } for every non-2xx instead of
 * throwing, so a deploy window 502 arrived in the same branch as a
 * spent invitation and was reported as "no longer valid" to people
 * whose link was perfectly good.
 */
function invitationProblem(
  error: { code?: string; status?: number; message?: string },
  signedInAs?: string,
): Problem {
  if (error.code === NOT_THE_RECIPIENT) {
    return {
      message: signedInAs
        ? `This invitation was sent to a different address. You are signed in as ${signedInAs}.`
        : "This invitation was sent to a different address than the one you are signed in with.",
      canSignOut: true,
    };
  }
  // Nothing here is a verdict on the invitation: the server either
  // failed, was busy, or never answered at all.
  const status = error.status ?? 0;
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return { message: LOOKUP_FAILED_MESSAGE, canRetry: true };
  }
  return { message: DEAD_INVITATION_MESSAGE };
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
  const [problem, setProblem] = useState<Problem | null>(null);
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
      setProblem({ message: MISSING_CODE_MESSAGE });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await authClient.organization.getInvitation({ query: { id: invitationId } });
        if (cancelled) return;
        if (result.error) {
          setPhase("error");
          setProblem(invitationProblem(result.error, session.user.email));
          return;
        }
        setOrganizationName((result.data as { organizationName?: string })?.organizationName ?? "the organization");
        setPhase("ready");
      } catch {
        // A thrown lookup is a connection problem, not a verdict on
        // the invitation, and must not strand the page on "checking".
        if (!cancelled) {
          setPhase("error");
          setProblem({ message: LOOKUP_FAILED_MESSAGE, canRetry: true });
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
    try {
      const result = accept
        ? await authClient.organization.acceptInvitation({ invitationId })
        : await authClient.organization.rejectInvitation({ invitationId });
      if (result.error) {
        setPhase("error");
        setProblem(invitationProblem(result.error, session?.user.email));
        return;
      }
      if (!accept) {
        setPhase("declined");
        return;
      }
      // Land the new member on the board they just joined. Best effort
      // on purpose: the membership already exists by now, and failing
      // to make it the active organization is not a failed join. Told
      // as one, it sent people back to an invitation they had in fact
      // accepted, which then answered that it was no longer valid.
      const orgId = (result.data as { invitation?: { organizationId?: string } })?.invitation?.organizationId;
      if (orgId) {
        await authClient.organization.setActive({ organizationId: orgId }).catch(() => undefined);
      }
      setPhase("accepted");
    } catch {
      // A throw is the connection, not an answer. Without this the
      // page sat on "Joining..." with both buttons disabled and
      // nothing said, and only a reload got out of it.
      setPhase("error");
      setProblem({ message: ACTION_FAILED_MESSAGE, canRetry: true });
    }
  }

  /** Back to the lookup, which settles what the invitation is now. */
  async function signOutAndRetry() {
    try {
      await authClient.signOut();
    } finally {
      // Reloaded rather than re-rendered: with the session gone this
      // page reopens on the invitation itself, which puts the sign in
      // form back with the invited address filled in.
      window.location.reload();
    }
  }

  if (phase === "error") {
    // Never an empty card: an error with no detail set is still an
    // error, and the dead invitation reading is the safe one.
    const shown = problem ?? { message: DEAD_INVITATION_MESSAGE };
    return (
      <InvitationProblem
        message={shown.message}
        onRetry={shown.canRetry ? () => setPhase("checking") : undefined}
        onSignOut={shown.canSignOut ? () => void signOutAndRetry() : undefined}
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
function InvitationProblem({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry?: () => void;
  /**
   * Offered when the session is the problem. Social sign in carries no
   * address constraint, so an invitee can arrive here authenticated as
   * somebody else entirely, and with a session in hand this page never
   * shows a sign in form again: without this button the only exits
   * were the board and the back button.
   */
  onSignOut?: () => void;
}) {
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
          {onSignOut && (
            <button className="btn btn-primary" onClick={onSignOut}>
              Sign out and use another account
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
