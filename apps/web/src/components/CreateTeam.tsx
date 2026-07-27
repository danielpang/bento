import { useState, type FormEvent } from "react";
import { authClient } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";

/**
 * The first thing a fresh account sees: name your team.
 *
 * Boards, agents, and credentials all belong to an organization, so a
 * user without one has nowhere to work. Asking up front, with the name
 * already filled in, beats dropping them on an empty board whose every
 * action fails for a reason they cannot see.
 */
export function CreateTeam({ userName, onCreated }: { userName: string; onCreated: () => void }) {
  const [name, setName] = useState(userName ? `${userName}'s organization` : "My organization");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError("");
    try {
      // Slugs are unique across the instance, so a common name can
      // collide with another team's; retry with a suffix rather than
      // bouncing the very first thing this account tries to do.
      let created = await authClient.organization.create({ name: trimmed, slug: slugify(trimmed) });
      if (created.error) {
        created = await authClient.organization.create({
          name: trimmed,
          slug: `${slugify(trimmed)}-${Math.random().toString(36).slice(2, 7)}`,
        });
      }
      if (created.error || !created.data) {
        setError(created.error?.message ?? "Could not create the team. Try again.");
        return;
      }
      await authClient.organization.setActive({ organizationId: created.data.id });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="card-panel">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Name your team</h1>
        </div>
        <p className="muted">
          Boards are shared inside a team. Yours can be a team of one; invite people whenever you
          like, from the Team panel.
        </p>
        <form onSubmit={submit} className="section">
          <label className="field">
            <span className="label">Team name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              maxLength={80}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating..." : "Create team"}
          </button>
        </form>
        <p className="muted">
          Joining someone else's team instead? Open the invitation link from your email, and skip
          this.
        </p>
      </div>
    </div>
  );
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}
