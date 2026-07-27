import { useState } from "react";
import { ConfirmDialog } from "./PromptDialog.js";
import { authClient, useActiveOrganization, useSession, signOut } from "../auth-client.js";
import { useToast } from "./Toasts.js";

/**
 * Leaving.
 *
 * Both actions here are irreversible and neither is urgent, so they sit
 * on their own tab rather than beside the controls people use daily,
 * and each says what it takes with it before it is confirmed. Deleting
 * an account is confirmed a second time by email; deleting an
 * organization takes its boards with it and happens at once, so it is
 * the one that has to be spelled out hardest.
 */
export function AccountSettings() {
  const toast = useToast();
  const { data: session } = useSession();
  const { data: active } = useActiveOrganization();
  const [confirming, setConfirming] = useState<"none" | "account" | "organization">("none");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const role = (active as { members?: { userId: string; role: string }[] } | null)?.members?.find(
    (member) => member.userId === session?.user.id,
  )?.role;
  const isOwner = role === "owner";

  async function act(fn: () => Promise<{ error?: { message?: string } | null }>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      const result = await fn();
      if (result.error) {
        toast.fail(result.error.message ?? "That did not work. Try again.");
        return;
      }
      setNotice(success);
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">Your sign in, and the door out. Both actions below are permanent.</p>

      <section className="section settings-card">
        <h3 className="settings-title">Signed in as</h3>
        {notice && <p className="muted">{notice}</p>}
        <p className="muted">
          {session?.user.name ? `${session.user.name}, ` : ""}
          {session?.user.email}
        </p>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>

      {active && (
        <section className="section settings-card">
          <h3 className="settings-title">Delete this organization</h3>
          <p className="muted">
            Deletes <strong>{active.name}</strong> and everything inside it: every project, board,
            card, agent, run transcript, and saved credential. Other members lose access at once.
            Any subscription is cancelled. This cannot be undone.
          </p>
          {!isOwner && <p className="muted">Only an owner can delete an organization.</p>}
          <div className="actions">
            <button
              className="btn btn-danger"
              disabled={busy || !isOwner}
              onClick={() => setConfirming("organization")}
            >
              Delete organization
            </button>
          </div>
        </section>
      )}

      <section className="section settings-card">
        <h3 className="settings-title">Delete your account</h3>
        <p className="muted">
          Removes your sign in and your membership of every team. Boards owned by a team you share
          stay with that team, so deleting your account does not delete their work. We email you a
          link to confirm before anything is removed.
        </p>
        <div className="actions">
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirming("account")}>
            Delete account
          </button>
        </div>
      </section>

      {confirming === "organization" && active && (
        <ConfirmDialog
          title={`Delete ${active.name}?`}
          description="Every project, card, agent, and credential in this organization goes with it, for everyone in it. Any subscription is cancelled. There is no undo."
          confirmLabel="Delete this organization"
          destructive
          onClose={() => setConfirming("none")}
          onConfirm={() =>
            act(async () => {
              const result = await authClient.organization.delete({ organizationId: active.id });
              if (!result.error) window.location.assign("/");
              return result;
            }, "Organization deleted.")
          }
        />
      )}

      {confirming === "account" && (
        <ConfirmDialog
          title="Delete your account?"
          description="We send a link to your address. The account is removed only once you open it, so nothing happens until you confirm from your inbox."
          confirmLabel="Email me the link"
          destructive
          onClose={() => setConfirming("none")}
          onConfirm={() =>
            act(
              () => authClient.deleteUser({ callbackURL: "/" }),
              "Check your inbox: the link there finishes the deletion.",
            )
          }
        />
      )}
    </>
  );
}
