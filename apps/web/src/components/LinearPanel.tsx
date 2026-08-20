import { useCallback, useEffect, useState } from "react";
import type {
  BentoClient,
  LinearConnection,
  LinearIssueOption,
  LinearTeamOption,
  Project,
} from "@bento/api-client";
import { ConfirmDialog } from "./PromptDialog.js";
import { SecretField } from "./SecretField.js";
import { useToast } from "./Toasts.js";

/**
 * The Linear tab: connect a workspace, decide which teams feed which
 * projects, and pull issues in by hand when the automatic paths do not
 * apply. Load failure stays distinct from "not connected" for the same
 * reason the credentials cards keep them apart: a failed fetch rendered
 * as disconnected invites pasting a key that is already there.
 */
export function LinearPanel({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [status, setStatus] = useState<LinearConnection | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await client.linearStatus());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    try {
      setProjects(await client.listProjects());
    } catch {
      // The mapping selects simply stay empty.
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
        <h3 className="settings-title">Linear</h3>
        <p className="error">
          Could not reach the server, so this cannot say whether Linear is connected.
        </p>
        <button className="btn" disabled={busy} onClick={() => void act(async () => {})}>
          Retry
        </button>
      </section>
    );
  }
  if (!status) return <div className="center" />;

  if (!status.connected) {
    return <ConnectCard client={client} busy={busy} act={act} />;
  }

  return (
    <>
      <section className="section settings-card">
        <h3 className="settings-title">Linear</h3>
        <p className="muted">Connected. Key saved {status.hint ?? ""}.</p>
        {status.webhook ? (
          <p className="muted">
            Linear notifies this server as issues change, so imports and updates arrive on their
            own.
          </p>
        ) : (
          <p className="muted">
            Linear cannot reach this server, so changes arrive on a sweep every 15 minutes. Use
            Sync now to pull the mapped backlogs immediately.
          </p>
        )}
        <p className="muted">
          Whether a card created in Bento files an issue, and which team it lands in, is set per
          project: open Settings, then Projects, and pick the project.
        </p>
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await client.syncLinearNow();
                toast.note("Sync queued. Mapped backlogs land on the board shortly.");
              })
            }
          >
            Sync now
          </button>
          {status.canManage && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => setDisconnecting(true)}>
              Disconnect
            </button>
          )}
        </div>
      </section>

      <MappingsCard client={client} status={status} projects={projects} busy={busy} act={act} />
      <ImportCard client={client} projects={projects} />

      {disconnecting && (
        <ConfirmDialog
          title="Disconnect Linear?"
          description="Team mappings and issue links are removed. Imported cards stay on the board, but they stop following their Linear issues and Linear stops hearing about their progress."
          confirmLabel="Disconnect"
          destructive
          onClose={() => setDisconnecting(false)}
          onConfirm={() => act(() => client.disconnectLinear())}
        />
      )}
    </>
  );
}

function ConnectCard({
  client,
  busy,
  act,
}: {
  client: BentoClient;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const toast = useToast();
  const [value, setValue] = useState("");
  return (
    <section className="section settings-card">
      <h3 className="settings-title">Linear</h3>
      <p className="muted">
        Bring your Linear backlog onto the board. Map a team to a project to sync its backlog, add
        a "bento" label to any issue to pull it in ad hoc, or import issues by hand. As cards move
        through the pipeline, their Linear issues follow: state changes plus a comment naming the
        stage. It works the other way too: a card created in Bento files an issue, which each
        project can turn off in its own settings. Paste a personal API key from Linear under Settings, then Security
        and access. It stays on the server, encrypted, and is never given to an agent.
      </p>
      <SecretField
        value={value}
        onChange={setValue}
        onSubmit={() =>
          void act(async () => {
            const result = await client.connectLinear(value.trim());
            setValue("");
            toast.note(
              result.webhook
                ? "Connected. Linear will notify this server as issues change."
                : "Connected. Changes sync on a schedule, or with Sync now.",
            );
          })
        }
        label="Linear API key"
        placeholder="lin_api_..."
        submitLabel="Connect"
        busy={busy}
      />
    </section>
  );
}

function MappingsCard({
  client,
  status,
  projects,
  busy,
  act,
}: {
  client: BentoClient;
  status: LinearConnection;
  projects: Project[];
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [teams, setTeams] = useState<LinearTeamOption[]>([]);
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    void client
      .listLinearTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [client]);

  const unmapped = teams.filter((team) => !status.mappings.some((m) => m.linearTeamId === team.id));
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "a removed project";

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Team mappings</h3>
      <p className="muted">
        Each mapped team's backlog issues become cards in its project. New backlog issues in a
        mapped team arrive as they are created. Whether an arriving issue waits in the backlog or
        starts the pipeline is each project's own setting, under Settings, Projects.
      </p>
      {status.mappings.length === 0 && <p className="muted">No teams mapped yet.</p>}
      {status.mappings.map((mapping) => (
        <div key={mapping.id} className="criterion">
          <span className="criterion-cmd">
            {mapping.linearTeamName} ({mapping.linearTeamKey}) syncs into {projectName(mapping.projectId)}
          </span>
          {status.canManage && (
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void act(() => client.deleteLinearMapping(mapping.id))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {status.canManage && unmapped.length > 0 && projects.length > 0 && (
        <div className="actions">
          <select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Linear team">
            <option value="">Pick a Linear team</option>
            {unmapped.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.key})
              </option>
            ))}
          </select>
          <select
            className="input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Bento project"
          >
            <option value="">Pick a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={busy || !teamId || !projectId}
            onClick={() =>
              void act(async () => {
                await client.createLinearMapping({ linearTeamId: teamId, projectId });
                setTeamId("");
                setProjectId("");
              })
            }
          >
            Map team
          </button>
        </div>
      )}
      <div className="field">
        <h4 className="field-heading">Default project for labeled issues</h4>
        <p className="muted">
          An issue labeled "bento" in an unmapped team lands here. Leave unset to ignore labels
          outside mapped teams.
        </p>
        <select
          className="input"
          value={status.defaultProjectId ?? ""}
          disabled={busy || !status.canManage}
          aria-label="Default project"
          onChange={(e) =>
            void act(() => client.setLinearSettings({ defaultProjectId: e.target.value || null }))
          }
        >
          <option value="">No default project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

function ImportCard({ client, projects }: { client: BentoClient; projects: Project[] }) {
  const toast = useToast();
  const [teams, setTeams] = useState<LinearTeamOption[]>([]);
  const [teamId, setTeamId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [issues, setIssues] = useState<LinearIssueOption[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client
      .listLinearTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [client]);

  const loadIssues = useCallback(
    async (team: string, after?: string) => {
      setBusy(true);
      try {
        const page = await client.listLinearIssues(team, after);
        setIssues((current) => (after ? [...current, ...page.issues] : page.issues));
        setCursor(page.hasNextPage ? page.endCursor : null);
      } catch (err) {
        toast.fail(err);
      } finally {
        setBusy(false);
      }
    },
    [client, toast],
  );

  useEffect(() => {
    setIssues([]);
    setSelected(new Set());
    setCursor(null);
    if (teamId) void loadIssues(teamId);
  }, [teamId, loadIssues]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importSelected() {
    setBusy(true);
    try {
      const result = await client.importLinearIssues({ issueIds: [...selected], projectId });
      toast.note(
        result.imported === 1
          ? "Imported 1 issue to the backlog."
          : `Imported ${result.imported} issues to the backlog.`,
      );
      setSelected(new Set());
      if (teamId) await loadIssues(teamId);
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Import issues</h3>
      <p className="muted">
        Pull specific issues in without mapping the whole team. Imported issues become backlog
        cards and stay linked to Linear.
      </p>
      <div className="actions">
        <select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Browse team">
          <option value="">Pick a team to browse</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name} ({team.key})
            </option>
          ))}
        </select>
        <select
          className="input"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Import into project"
        >
          <option value="">Import into project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary"
          disabled={busy || selected.size === 0 || !projectId}
          onClick={() => void importSelected()}
        >
          Import {selected.size > 0 ? `(${selected.size})` : ""}
        </button>
      </div>
      {teamId && issues.length === 0 && !busy && (
        <p className="muted">No open backlog issues in this team.</p>
      )}
      {issues.map((issue) => (
        <ImportIssueRow
          key={issue.id}
          issue={issue}
          checked={selected.has(issue.id)}
          busy={busy}
          onToggle={() => toggle(issue.id)}
        />
      ))}
      {cursor && teamId && (
        <button className="btn btn-ghost" disabled={busy} onClick={() => void loadIssues(teamId, cursor)}>
          Load more
        </button>
      )}
    </section>
  );
}

/** Why an already linked row will not check, at length. */
const ALREADY_IN_BENTO = "This issue is already a card in Bento, so it cannot be imported again.";

/**
 * One issue in the import list.
 *
 * An issue Bento already has cannot be selected, and a checkbox that
 * refuses with no reason beside it reads as broken, so the row says why
 * twice: a chip for anyone scanning the list, and hover text for the
 * longer version. The chip sits inside the label, so it is part of the
 * checkbox's name rather than decoration a screen reader skips.
 *
 * The link is unique per organization, not per project, so the chip
 * claims Bento has the issue and not that this project does.
 */
export function ImportIssueRow({
  issue,
  checked,
  busy,
  onToggle,
}: {
  issue: LinearIssueOption;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="gate-check" title={issue.imported ? ALREADY_IN_BENTO : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={busy || issue.imported}
        onChange={onToggle}
      />
      <span className="gate-check-text">
        {issue.identifier} {issue.title}
      </span>
      {issue.imported && <span className="chip chip-soft">Already in Bento</span>}
    </label>
  );
}
