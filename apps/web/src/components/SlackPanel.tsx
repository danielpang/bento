import { useCallback, useEffect, useState } from "react";
import type { BentoClient, Project, SlackConnection } from "@bento/api-client";
import { ConfirmDialog } from "./PromptDialog.js";
import { useToast } from "./Toasts.js";

/**
 * The Slack tab: install the app into a workspace, and pick the
 * project @bento uses for this person when they do not choose one
 * in Slack.
 */
export function SlackPanel({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [status, setStatus] = useState<SlackConnection | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useSlackOutcome();

  const reload = useCallback(async () => {
    try {
      setStatus(await client.slackStatus());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    try {
      setProjects(await client.listProjects());
    } catch {
      // The default-project select simply stays empty.
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">Slack</h3>
        <p className="error">
          Could not reach the server, so this cannot say whether Slack is connected.
        </p>
        <button className="btn" disabled={busy} onClick={() => void act(async () => {})}>
          Retry
        </button>
      </section>
    );
  }
  if (!status) return <div className="center" />;

  if (!status.configured) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">Slack</h3>
        <p className="muted">
          Slack is not configured on this server. An operator can set SLACK_CLIENT_ID,
          SLACK_CLIENT_SECRET, and SLACK_SIGNING_SECRET. See docs/slack.md.
        </p>
      </section>
    );
  }

  if (!status.connected) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">Slack</h3>
        <p className="muted">
          Install Bento in a Slack workspace to create cards with @bento and get stage
          progress, write-ups, and review buttons in that thread.
        </p>
        {status.canManage ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const { url } = await client.startSlackInstall();
                window.location.assign(url);
              })
            }
          >
            Install Slack app
          </button>
        ) : (
          <p className="muted">An owner or admin of this organization can install Slack.</p>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="section settings-card">
        <h3 className="settings-title">Slack</h3>
        <p className="muted">Connected to {status.teamName ?? "a Slack workspace"}.</p>
        <p className="muted">
          Invite @bento to a channel, then tag it to create a card. Progress, stage write-ups,
          and review buttons land in that thread.
        </p>
        {status.canManage && status.interactivityUrl && (
          <p className="muted">
            Slack Interactivity request URL must be {status.interactivityUrl}. Without that,
            project buttons and Approve do nothing.
          </p>
        )}
        {status.canManage && (
          <div className="actions">
            <button className="btn btn-ghost" disabled={busy} onClick={() => setDisconnecting(true)}>
              Disconnect
            </button>
          </div>
        )}
      </section>

      <section className="section settings-card">
        <h3 className="settings-title">Your default project</h3>
        <p className="muted">
          When you tag @bento, the card goes here unless you pick a project in Slack. Leave it
          unset to be asked every time.
        </p>
        <select
          className="input"
          value={status.defaultProjectId ?? ""}
          disabled={busy}
          aria-label="Default project for Slack cards"
          onChange={(e) => {
            const value = e.target.value || null;
            void act(() => client.setSlackSettings({ defaultProjectId: value }));
          }}
        >
          <option value="">Ask me each time</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </section>

      {disconnecting && (
        <ConfirmDialog
          title="Disconnect Slack?"
          description="The Slack app is removed from this Bento team. Existing cards stay on the board, but Slack threads stop receiving progress."
          confirmLabel="Disconnect"
          destructive
          onClose={() => setDisconnecting(false)}
          onConfirm={() => act(() => client.disconnectSlack())}
        />
      )}
    </>
  );
}

const OUTCOMES: Record<string, string> = {
  connected: "Slack is connected.",
  invalid: "That Slack install link had expired. Start the install again.",
  organization: "You switched organizations part way through. Switch back and install again.",
  denied: "Only an owner or admin of this organization can connect Slack.",
  unconfigured: "Slack is not configured on this server.",
  taken: "That Slack workspace is already connected to another Bento team.",
};

function useSlackOutcome(): void {
  const toast = useToast();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("slack");
    if (!result) return;
    const message = OUTCOMES[result];
    if (message) {
      if (result === "connected") toast.note(message);
      else toast.fail(message);
    }
    params.delete("slack");
    const query = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [toast]);
}
