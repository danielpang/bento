import { useEffect, useState } from "react";
import { ConfirmDialog } from "./PromptDialog.js";
import { Modal } from "./Modal.js";
import {
  authClient,
  useActiveOrganization,
  useListOrganizations,
  useSession,
  signOut,
} from "../auth-client.js";
import { useToast } from "./Toasts.js";

/**
 * Whether a membership holds the owner role.
 *
 * Roles arrive as a comma separated string, so this parses the way the
 * server does rather than comparing the whole field: a member who is
 * "owner,admin" is an owner, and `role === "owner"` would miss them.
 */
function roleHasOwner(role: string): boolean {
  return role.split(",").map((part) => part.trim()).includes("owner");
}

/**
 * Organizations this person still owns. An account deletion would
 * leave those teams without an owner, so the button stays off until
 * each one has another, or is deleted.
 */
function useOwnedOrganizations(): { id: string; name: string }[] | null {
  const { data: session } = useSession();
  const { data: organizations } = useListOrganizations();
  const [owned, setOwned] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) {
      setOwned([]);
      return;
    }
    if (!organizations) {
      setOwned(null);
      return;
    }
    let cancelled = false;
    void Promise.all(
      organizations.map(async (org) => {
        const full = await authClient.organization.getFullOrganization({
          query: { organizationId: org.id },
        });
        const members =
          (full.data as { members?: { userId: string; role: string }[] } | null)?.members ?? [];
        const role = members.find((member) => member.userId === userId)?.role ?? "";
        return roleHasOwner(role) ? { id: org.id, name: org.name } : null;
      }),
    ).then((rows) => {
      if (!cancelled) {
        setOwned(rows.filter((row): row is { id: string; name: string } => row !== null));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [organizations, session?.user.id]);

  return owned;
}

function ownedAccountMessage(names: string[]): string {
  if (names.length === 1) {
    return `You own ${names[0]}. Make someone else an owner first, or delete that organization.`;
  }
  return `You own ${names.join(", ")}. Make someone else an owner in each, or delete them, before you can delete your account.`;
}

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
  const ownedOrgs = useOwnedOrganizations();
  const [confirming, setConfirming] = useState<"none" | "account" | "organization">("none");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const role = (active as { members?: { userId: string; role: string }[] } | null)?.members?.find(
    (member) => member.userId === session?.user.id,
  )?.role;
  const isOwner = role ? roleHasOwner(role) : false;
  const ownsOrganizations = (ownedOrgs ?? []).length > 0;

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
        {ownsOrganizations && ownedOrgs && (
          <p className="muted">{ownedAccountMessage(ownedOrgs.map((org) => org.name))}</p>
        )}
        <div className="actions">
          <button
            className="btn btn-danger"
            disabled={busy || ownedOrgs === null || ownsOrganizations}
            onClick={() => setConfirming("account")}
          >
            Delete account
          </button>
        </div>
      </section>

      {confirming === "organization" && active && (
        <DeleteOrganizationDialog
          name={active.name}
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

/**
 * The name has to be typed: Delete organization sits next to other
 * settings actions, and a confirm that is only a click is too close to
 * reach by accident for something that takes the whole team with it.
 */
function DeleteOrganizationDialog({
  name,
  onClose,
  onConfirm,
}: {
  name: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmed = typed.trim() === name;

  async function remove() {
    if (!confirmed || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Delete ${name}?`}
      description="Every project, card, agent, and credential in this organization goes with it, for everyone in it. Any subscription is cancelled. There is no undo."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="delete-organization" className="btn btn-danger" disabled={busy || !confirmed}>
            Delete this organization
          </button>
        </>
      }
    >
      <form
        id="delete-organization"
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <label className="field">
          <span className="label">Type the organization name to confirm</span>
          <input
            className="input"
            value={typed}
            placeholder={name}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </label>
      </form>
    </Modal>
  );
}
