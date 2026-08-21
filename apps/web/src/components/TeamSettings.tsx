import { useEffect, useState } from "react";
import { ConfirmDialog } from "./PromptDialog.js";
import { ListRowsSkeleton, SettingsCardSkeleton } from "./Skeleton.js";
import type { BentoClient } from "@bento/api-client";
import { authClient, useActiveOrganization, useListOrganizations } from "../auth-client.js";
import { useToast } from "./Toasts.js";
import { seatChangeNote, useBillingPlan } from "./billing-plan.js";

interface Member {
  id: string;
  role: string;
  user: { id: string; name: string; email: string };
}

interface Invitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
}

/**
 * Whether a member holds the owner role.
 *
 * Roles arrive as a comma separated string, so this parses the way the
 * server does rather than comparing the whole field: a member who is
 * "owner,admin" is an owner, and `role === "owner"` would miss them.
 */
function isOwner(member: Member): boolean {
  return member.role.split(",").map((r) => r.trim()).includes("owner");
}

/** What each role may do, since the bare word does not say. */
const ROLES = [
  { id: "member", label: "Member", help: "Uses the boards: runs agents, approves cards." },
  { id: "admin", label: "Admin", help: "Everything a member can do, plus invites and credentials." },
  { id: "owner", label: "Owner", help: "Full control, including removing members and the organization itself." },
] as const;

/**
 * Organizations and who is in them. A team shares one board, so this is
 * where you create the team, invite people, and change what they can do.
 */
export function TeamSettings({ client }: { client: BentoClient }) {
  const toast = useToast();
  const { data: organizations, isPending: orgsPending } = useListOrganizations();
  const { data: active } = useActiveOrganization();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("member");
  const [newOrgName, setNewOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  /**
   * Whether the member list failed to load, which is not the same as an
   * organization of one. "Just you so far" on a failed fetch is a claim
   * about the team rather than about the request.
   */
  const [membersFailed, setMembersFailed] = useState(false);

  /**
   * Everyone holding the owner role. An organization must keep one, so
   * the last of them cannot be removed and the row says so rather than
   * offering a button the server will refuse.
   */
  const owners = (members ?? []).filter(isOwner);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [promoting, setPromoting] = useState<{ member: Member; role: string } | null>(null);
  /**
   * The pending invitation, held while the cost of the seat is
   * confirmed. Null on a deployment without billing, where the invite
   * goes straight out: there is nothing to warn anybody about.
   */
  const [confirmingInvite, setConfirmingInvite] = useState<string | null>(null);

  const activeId = active?.id ?? null;
  const { plan: billing } = useBillingPlan(busy);
  // A seat is billed the moment the invitation exists, so the price of
  // one is something to say before the button, not after it.
  const inviteCost = billing ? seatChangeNote(billing, 1) : null;
  const removalCredit = billing ? seatChangeNote(billing, -1) : null;

  async function loadMembers() {
    if (!activeId) return;
    const full = await authClient.organization.getFullOrganization({ query: { organizationId: activeId } });
    const data = full.data as unknown as { members?: Member[]; invitations?: Invitation[] } | null;
    setMembers(data?.members ?? []);
    setInvitations((data?.invitations ?? []).filter((i) => i.status === "pending"));
  }

  useEffect(() => {
    setMembersFailed(false);
    setMembers(null);
    void loadMembers().catch(() => setMembersFailed(true));
  }, [activeId]);

  /**
   * Sends the invitation, whether or not a confirmation preceded it.
   * The organization is checked here rather than trusted from the
   * caller: this used to sit inside a block that had already proved
   * there was one.
   */
  function sendInvite(email: string) {
    const organizationId = activeId;
    if (!organizationId) return;
    return act(async () => {
      const result = await authClient.organization.inviteMember({
        email,
        role: inviteRole as "member" | "admin" | "owner",
        organizationId,
      });
      setInviteEmail("");
      return result;
    }, "Invitation sent");
  }

  async function act(
    fn: () => Promise<{ error?: { message?: string } | null }>,
    success: string,
    after?: () => void,
  ) {
    setBusy(true);
    setNotice("");
    try {
      const result = await fn();
      if (result.error) {
        toast.fail(result.error.message ?? "That did not work. Try again.");
        return;
      }
      setNotice(success);
      await loadMembers().catch(() => setMembersFailed(true));
      after?.();
    } catch (err) {
      // A thrown await here used to leave the whole panel disabled.
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
        <section className="section settings-card">
          <h3 className="settings-title">Organization</h3>
          {/*
            Said plainly because the control below is not a preference.
            Everything a board is made of belongs to one organization, so
            the picker swaps the whole workspace: a person who reads it
            as "which name appears at the top" switches and finds an
            empty board with none of their agents or keys.
          */}
          <p className="muted">
            Boards, cards, agents, members, and stored credentials all belong to an organization.
            Switching changes which of them you see.
          </p>
          {/* Errors and confirmations sit inside the card that caused
              them. At the top of a scrolling drawer, a key saved at the
              bottom reported success off screen, and a refusal looked
              exactly like a success. */}
          {notice && <p className="muted">{notice}</p>}
          {orgsPending ? (
            <ListRowsSkeleton rows={2} />
          ) : organizations && organizations.length > 0 ? (
            <label className="field">
              <span className="label">Current organization</span>
              <select
                className="select"
                value={activeId ?? ""}
                disabled={busy}
                onChange={(e) =>
                  act(
                    () => authClient.organization.setActive({ organizationId: e.target.value }),
                    "Switched organization",
                  )
                }
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted">You are not in an organization yet. Create one to share a board.</p>
          )}

          <h4 className="field-heading">New organization</h4>
          <p className="muted">Starts an empty board that you own, with no agents or credentials yet.</p>
          <div className="actions">
            <input
              className="input"
              placeholder="New organization name"
              value={newOrgName}
              onChange={(e) => setNewOrgName(e.target.value)}
              aria-label="New organization name"
            />
            <button
              className="btn"
              disabled={busy || !newOrgName.trim()}
              onClick={() =>
                act(async () => {
                  const name = newOrgName.trim();
                  // Slugs are unique across the whole instance, so a
                  // common name can collide with another team's. Retry
                  // with a suffix rather than making the user rename.
                  let created = await authClient.organization.create({ name, slug: slugify(name) });
                  if (created.error) {
                    created = await authClient.organization.create({
                      name,
                      slug: `${slugify(name)}-${Math.random().toString(36).slice(2, 7)}`,
                    });
                  }
                  if (!created.error && created.data) {
                    await authClient.organization.setActive({ organizationId: created.data.id });
                  }
                  setNewOrgName("");
                  return created;
                }, "Organization created")
              }
            >
              Create
            </button>
          </div>
        </section>

        {activeId && (
          <>
            <section className="section settings-card">
              <h3 className="settings-title">Members</h3>
              {membersFailed ? (
                <p className="error">Could not load the members of this organization. Retry once the server is reachable.</p>
              ) : members === null ? (
                <ListRowsSkeleton rows={3} />
              ) : (
                members.length === 0 && <p className="muted">Just you so far.</p>
              )}
              {(members ?? []).map((m) => (
                <div key={m.id} className="gate-check">
                  <span className="gate-check-text">
                    <span className="gate-check-name">{m.user.name || m.user.email}</span>
                    <br />
                    {m.user.email}
                  </span>
                  <select
                    className="select"
                    value={m.role}
                    disabled={busy}
                    aria-label={`Role for ${m.user.name || m.user.email}`}
                    onChange={(e) => {
                      const role = e.target.value;
                      // Owner is the one role that can remove everyone
                      // else, so granting it asks first. The rest apply
                      // straight away, the way a role picker reads.
                      if (role === "owner") return setPromoting({ member: m, role });
                      void act(
                        () =>
                          authClient.organization.updateMemberRole({
                            memberId: m.id,
                            role: role as "member" | "admin" | "owner",
                            organizationId: activeId,
                          }),
                        `${m.user.name || m.user.email} is now ${role === "admin" ? "an admin" : "a member"}`,
                      );
                    }}
                  >
                    {ROLES.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  {/*
                    An organization has to keep an owner, and the server
                    refuses to remove the last one. Offering the button
                    anyway would promise "they lose access immediately"
                    for something that can only end in an error, so the
                    row says why instead.
                  */}
                  <span className="member-action">
                    {isOwner(m) && owners.length <= 1 ? (
                      <span className="muted" title="An organization must keep an owner. Make someone else an owner first.">
                        Only owner
                      </span>
                    ) : (
                      <button
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => setRemovingMember(m)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </div>
              ))}
              <p className="muted">{ROLES.map((role) => `${role.label}: ${role.help}`).join(" ")}</p>

              {/* Inviting lives with the roster it grows: as its own
                  card further down, the two read as unrelated. */}
              <h4 className="field-heading">Invite a teammate</h4>
              <div className="actions">
                <input
                  className="input"
                  type="email"
                  placeholder="teammate@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  aria-label="Email to invite"
                />
                <select
                  className="select"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  aria-label="Role"
                >
                  {ROLES.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-primary"
                  disabled={busy || !inviteEmail.trim()}
                  onClick={() => {
                    const email = inviteEmail.trim();
                    if (!email) return;
                    // A seat that costs money gets confirmed first. On
                    // Free, or on a deployment with no billing at all,
                    // there is nothing to confirm and the extra click
                    // would just be in the way.
                    if (inviteCost) return setConfirmingInvite(email);
                    void sendInvite(email);
                  }}
                >
                  Invite
                </button>
              </div>
              {inviteCost && <p className="muted">Each person here holds a seat. {inviteCost}</p>}

              {invitations.length > 0 && (
                <div className="criteria-list">
                  {invitations.map((invite) => (
                    <div key={invite.id} className="criterion">
                      <span className="criterion-cmd">
                        {invite.email} ({invite.role ?? "member"}) waiting
                      </span>
                      <button
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () => authClient.organization.cancelInvitation({ invitationId: invite.id }),
                            "Invitation cancelled",
                          )
                        }
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <NetworkPolicyCard />

            {/*
              Agent credentials belong to the organization, not the
              server: without them the operator's own key would end up
              inside every tenant's sandbox. They are entered under
              Agents, which is the one door for them in every mode; a
              second copy here drifted from that one and showed neither
              which providers were set nor what was missing.
            */}
            <section className="section settings-card">
              <h3 className="settings-title">Agent credentials</h3>
              <p className="muted">
                This organization's model provider keys live under Agents, and its GitHub token on
                the GitHub tab here. Agents run on your keys, so nothing is billed to anyone else.
              </p>
              <div className="actions">
                <a className="btn" href="/">
                  Open the board, then Agents
                </a>
              </div>
            </section>

          </>
        )}

        {confirmingInvite && inviteCost && (
          <ConfirmDialog
            title={`Invite ${confirmingInvite}?`}
            description={`The seat is held as soon as the invitation goes out, whether or not it is accepted. ${inviteCost}`}
            confirmLabel="Invite and hold a seat"
            onClose={() => setConfirmingInvite(null)}
            onConfirm={() => sendInvite(confirmingInvite)}
          />
        )}

        {removingMember && activeId && (
          <ConfirmDialog
            title={`Remove ${removingMember.user.name || removingMember.user.email}?`}
            description={`They lose access to this organization's boards immediately. Work they already did stays on the cards.${removalCredit ? ` The seat is released. ${removalCredit}` : ""}`}
            confirmLabel="Remove member"
            destructive
            onClose={() => setRemovingMember(null)}
            onConfirm={() =>
              act(
                () =>
                  authClient.organization.removeMember({
                    memberIdOrEmail: removingMember.id,
                    organizationId: activeId,
                  }),
                "Member removed",
              )
            }
          />
        )}

        {promoting && activeId && (
          <ConfirmDialog
            title={`Make ${promoting.member.user.name || promoting.member.user.email} an owner?`}
            description="Owners can remove members, change anyone's role, and delete the organization. This cannot be undone by them refusing it."
            confirmLabel="Make owner"
            onClose={() => setPromoting(null)}
            onConfirm={() =>
              act(
                () =>
                  authClient.organization.updateMemberRole({
                    memberId: promoting.member.id,
                    role: "owner",
                    organizationId: activeId,
                  }),
                "Role updated",
              )
            }
          />
        )}
    </>
  );
}

/**
 * Whether this team's agents may reach the internet.
 *
 * Opt in, and fail closed: an agent can read anything its sandbox can,
 * so a team handling sensitive code may want its runs to have no route
 * out at all. The deployment has to provide that network, and the
 * control says so rather than offering a switch that quietly does
 * nothing.
 */
function NetworkPolicyCard() {
  const toast = useToast();
  const [state, setState] = useState<{ restrictNetwork: boolean; canEdit: boolean; supported: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch("/api/team/policy", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setState(body as typeof state))
      .catch(() => setState(null))
      .finally(() => setReady(true));
  }, []);

  if (!ready) return <SettingsCardSkeleton rows={2} />;
  if (!state) return null;

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/team/policy", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restrictNetwork: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "That did not work. Try again.");
      setState((current) => (current ? { ...current, restrictNetwork: next } : current));
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Agent network access</h3>
      <p className="muted">
        By default an agent can reach the internet from its sandbox, which is what lets it install
        packages and read documentation. Locking it down runs every agent on a network with no route
        out, for teams whose code should not leave the machine.
      </p>
      {!state.supported && (
        <p className="muted">
          This deployment has no restricted network configured yet, so the setting cannot be turned
          on. The server needs BENTO_SANDBOX_RESTRICTED_NETWORK.
        </p>
      )}
      <label className="gate-check">
        <input
          type="checkbox"
          checked={state.restrictNetwork}
          disabled={busy || !state.canEdit || (!state.supported && !state.restrictNetwork)}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="gate-check-text">
          Block network access for every agent in this team. Runs that need the internet will fail
          rather than reach it.
        </span>
      </label>
      {!state.canEdit && <p className="muted">Only an owner or admin can change this.</p>}
    </section>
  );
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `org-${Date.now()}`
  );
}
