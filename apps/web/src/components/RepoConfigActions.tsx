import { useCallback, useEffect, useState } from "react";
import type { BentoClient, RepoConfigStatus } from "@bento/api-client";
import { BetaOnly } from "../beta.js";
import { useToast } from "./Toasts.js";

/**
 * The repository's own copy of the pipeline and agents files.
 *
 * Export and import move the files by hand. This is the other half:
 * the files live at `.bento/` in the checkout, Bento reads them back
 * from there, and a pull request puts them there in the first place.
 * Shared by the Pipeline panel and Settings, Config, like the buttons
 * above it, so the two places say the same thing.
 */
export function RepoConfigActions({
  client,
  projectId,
  canPublish,
  onChanged,
}: {
  client: BentoClient;
  projectId: string | null;
  /** Whether a pull request could be opened from here today; null while unknown. */
  canPublish: boolean | null;
  /** Called after a sync changed the pipeline, so the board re-reads it. */
  onChanged: () => void;
}) {
  return (
    <BetaOnly>
      <RepoConfigSection client={client} projectId={projectId} canPublish={canPublish} onChanged={onChanged} />
    </BetaOnly>
  );
}

function RepoConfigSection({
  client,
  projectId,
  canPublish,
  onChanged,
}: {
  client: BentoClient;
  projectId: string | null;
  canPublish: boolean | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<RepoConfigStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What the last action did, so a button press is not silent. */
  const [outcome, setOutcome] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setStatus(await client.repoConfig(projectId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    setStatus(null);
    setOutcome("");
    void load();
  }, [load]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setOutcome("");
    try {
      setOutcome(await fn());
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function sync() {
    if (!projectId) return;
    await act(async () => {
      const result = await client.syncRepoConfig(projectId);
      if (result.status !== "applied") return "Nothing to apply.";
      onChanged();
      const parts: string[] = [];
      if (result.pipeline) parts.push(`${result.pipeline.stages} stages`);
      const agents = result.pipeline ? result.pipeline.agents + (result.agents ?? 0) : result.agents ?? 0;
      parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
      const removed = result.pipeline?.removedStages ?? [];
      return `Applied ${parts.join(" and ")} from ${result.repository.name}.${
        removed.length > 0 ? ` Removed: ${removed.join(", ")}.` : ""
      }`;
    });
  }

  async function publish() {
    if (!projectId) return;
    await act(async () => {
      const result = await client.publishRepoConfig(projectId);
      if (result.unchanged) return `${result.repository.name} already has these exact files.`;
      window.open(result.url, "_blank", "noopener");
      return `Opened pull request #${result.prNumber} in ${result.repository.name}.`;
    });
  }

  const found = status && (status.found.pipeline || status.found.agents);
  const files = status
    ? [status.found.pipeline && status.paths.pipeline, status.found.agents && status.paths.agents].filter(Boolean)
    : [];

  return (
    <section className="section">
      <span className="label">In the repository</span>
      <p className="muted">
        Keep the files at <code>.bento/pipeline.yaml</code> and <code>.bento/agents.yaml</code> in the
        repository. Bento applies them when a project is created from it, and again whenever they change
        on the default branch. A file that does not validate is refused whole and the board is left as it
        was.
      </p>
      {failed ? (
        <p className="error">Could not read the repository. Retry once the server is reachable.</p>
      ) : status?.unavailable ? (
        <p className="muted">{capitalise(status.unavailable)}</p>
      ) : status && !found ? (
        <p className="muted">Not in the repository yet. Open a pull request to add them.</p>
      ) : status && status.repository ? (
        <p className="muted">
          {status.repository.name} has {files.join(" and ")}.{" "}
          {status.changed
            ? "They have changed since they were last applied."
            : status.syncedAt
              ? `Applied ${new Date(status.syncedAt).toLocaleString()}.`
              : ""}
        </p>
      ) : null}
      {status?.error && <p className="error">{capitalise(status.error)}</p>}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !projectId || !found}
          title={found ? "Apply the files in the repository to this board now" : "The repository has no .bento files yet"}
          onClick={() => void sync()}
        >
          Sync from repository
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !projectId || canPublish === false}
          title={
            canPublish === false
              ? "Connect GitHub under Settings to open pull requests"
              : "Commit both files to a new branch and open a pull request"
          }
          onClick={() => void publish()}
        >
          Open a pull request
        </button>
      </div>
      {outcome && <p className="muted">{outcome}</p>}
    </section>
  );
}

/** Server messages start lower case so they read inside a sentence; alone they get a capital. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
