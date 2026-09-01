import { useEffect, useState } from "react";
import type { BentoClient, GitHubConnection } from "@bento/api-client";
import { authClient } from "../auth-client.js";
import { useToast } from "./Toasts.js";
import { SettingsCardSkeleton } from "./Skeleton.js";

const CONNECT_NOTE =
  "Sends you to GitHub to confirm who you are, then back here. It is your own account, not the "
  + "organization's: it proves an installation is yours to connect, and nothing is pushed with it.";

/**
 * Attaching a GitHub account to a Bento account that has none.
 *
 * Installing the App is only offered to someone GitHub already shows
 * the installation to, which is how Bento knows an installation is
 * theirs to bind. Signing in with GitHub answers that on its own;
 * signing up with an email and a password does not, and until this
 * existed those accounts reached the install button, followed it to
 * GitHub, and came back to a refusal with nothing on offer that would
 * fix it. This is that missing step, in front of the button rather
 * than after it.
 *
 * The addresses on the two accounts need not match: this runs inside a
 * signed-in session and finishes GitHub's own OAuth, so both identities
 * are proven here.
 */
export function ConnectGitHubAccount({
  status,
  returnTo,
  primary = true,
  label = "Connect GitHub account",
  note = CONNECT_NOTE,
}: {
  status: GitHubConnection;
  /** Where GitHub sends the browser back, so people keep their place. */
  returnTo: string;
  primary?: boolean;
  label?: string;
  note?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!status.canLinkIdentity) {
    return (
      <p className="muted">
        Connecting the GitHub App needs GitHub sign in, which this server does not have configured.
        An operator can set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. Until then, a GitHub token
        under Settings, GitHub still opens pull requests.
      </p>
    );
  }

  return (
    <>
      <button
        type="button"
        className={primary ? "btn btn-primary" : "btn"}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void authClient
            .linkSocial({
              provider: "github",
              callbackURL: withOutcome(returnTo, "identity-connected"),
              errorCallbackURL: withOutcome(returnTo, "identity-failed"),
            })
            .then((result) => {
              // A success navigates to GitHub and never gets here. A
              // refusal does, and leaves the button usable.
              if (result.error) toast.fail(result.error.message ?? "Could not start the GitHub connection.");
              setBusy(false);
            })
            .catch((err: unknown) => {
              toast.fail(err);
              setBusy(false);
            });
        }}
      >
        {label}
      </button>
      <p className="muted">{note}</p>
    </>
  );
}

/** A return address the outcome handler below will recognise. */
function withOutcome(returnTo: string, result: string): string {
  return `${returnTo}${returnTo.includes("?") ? "&" : "?"}github=${result}`;
}

/** Where this card sends people back to, keeping the tab they were on. */
const SETTINGS_RETURN = "/settings?tab=github";

const RECONNECT_NOTE =
  "Use this if GitHub has stopped recognising the connection, or to hand it to a different GitHub account.";

/**
 * The GitHub account behind the App installation, in settings.
 *
 * The install button lives with repositories, where a project is being
 * given something to work on. This is the other half: whose GitHub
 * account Bento checks an installation against, which is per person
 * rather than per project, and is the thing that is missing when the
 * install refuses. Someone sent here by that refusal can finish it
 * without going back to the board, so the install button is offered
 * again once the account is attached.
 */
export function GitHubAccountCard({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [status, setStatus] = useState<GitHubConnection | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client
      .githubStatus()
      .then((next) => {
        setStatus(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [client]);

  if (failed) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">Your GitHub account</h3>
        <p className="error">
          Could not reach the server, so this cannot say whether a GitHub account is connected.
        </p>
      </section>
    );
  }

  if (!status) return <SettingsCardSkeleton rows={2} />;

  // Local mode has one trusted user and no sign in, so there is no
  // account to attach and nothing here to say.
  if (!status.configured && !status.canLinkIdentity) return null;

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Your GitHub account</h3>
      <p className="muted">
        Bento checks the App installation against your own GitHub account, so connect yours here
        first.
      </p>
      {status.identityLinked ? (
        <>
          <p className="muted">Your GitHub account is connected.</p>
          {status.configured && !status.connected && status.canManage && (
            <div className="actions">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void client
                    .startGitHubInstall()
                    .then(({ url }) => window.location.assign(url))
                    .catch((err: unknown) => {
                      toast.fail(err);
                      setBusy(false);
                    });
                }}
              >
                Install GitHub App
              </button>
            </div>
          )}
          {status.connected && status.installation && (
            <p className="muted">
              The App is installed on {status.installation.accountLogin}. Choose which repositories
              a project spans under Repositories.
            </p>
          )}
          {status.canLinkIdentity && (
            <ConnectGitHubAccount
              status={status}
              returnTo={SETTINGS_RETURN}
              primary={false}
              label="Reconnect GitHub account"
              note={RECONNECT_NOTE}
            />
          )}
        </>
      ) : (
        <ConnectGitHubAccount status={status} returnTo={SETTINGS_RETURN} />
      )}
    </section>
  );
}

const OUTCOMES: Record<string, string> = {
  connected: "GitHub is connected. Choose the repositories this project spans under Repositories.",
  "identity-connected":
    "Your GitHub account is connected. Installing the Bento GitHub App is the next step.",
  "identity-failed": "Could not connect that GitHub account. Nothing changed, so it is safe to try again.",
  identity: "Connect your GitHub account first, then install the App.",
  stale: "Your GitHub account is no longer connected to Bento. Connect it again, then install the App.",
  unseen:
    "That installation is not visible to your GitHub account. Connect the GitHub account that manages it.",
  invalid: "That installation link had expired. Start the install again.",
  organization: "You switched organizations part way through. Switch back and install again.",
  denied: "Only an owner or admin of this organization can connect GitHub.",
  unconfigured: "The GitHub App is not configured on this server.",
};

/**
 * Says how an install or a GitHub connection turned out.
 *
 * Both journeys leave the app for github.com and come back to a plain
 * address, so the outcome can only travel in the query string. It is
 * read once, said in a toast, and then taken back out of the address so
 * a reload does not repeat it. Whatever GitHub or better-auth reported
 * rides along in `error`, which is worth showing: "email doesn't match"
 * is a different afternoon from "already linked to another account".
 */
export function useGitHubOutcome(): void {
  const toast = useToast();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github");
    if (!result) return;
    const detail = params.get("error");
    const message = OUTCOMES[result];
    if (message) {
      const full = detail && result === "identity-failed" ? `${message} GitHub said: ${detail}.` : message;
      if (result === "connected" || result === "identity-connected") toast.note(full);
      else toast.fail(full);
    }
    params.delete("github");
    params.delete("error");
    const query = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [toast]);
}
