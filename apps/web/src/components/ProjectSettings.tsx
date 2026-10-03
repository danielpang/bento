import { useEffect, useState } from "react";
import type {
  BentoClient,
  LinearConnection,
  LinearProjectOption,
  LinearTeamOption,
  Project,
  SandboxProviderSetting,
} from "@bento/api-client";
import { ApiError } from "@bento/api-client";
import type { SandboxProvider } from "@bento/core";
import { BetaOnly } from "../beta.js";
import { useToast } from "./Toasts.js";
import { SettingsCardSkeleton } from "./Skeleton.js";

/**
 * One project's own settings, opened from the Projects tab. Today that
 * is what happens either side of the Linear boundary: whether an
 * arriving issue starts the pipeline, and where a card made here files
 * its issue. Anything else a project decides for itself belongs here
 * too.
 *
 * The connection status is loaded once here and shared by both cards,
 * with "failed" kept distinct from "not connected": a failed fetch
 * rendered as disconnected invites reconnecting a workspace that is
 * already there.
 */
export function ProjectSettings({
  client,
  project,
  onBack,
  onChanged,
}: {
  client: BentoClient;
  project: Project;
  onBack: () => void;
  /** The parent owns the project rows, so edits ask it to reload them. */
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<LinearConnection | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    void client
      .linearStatus()
      .then((s) => {
        setStatus(s);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  }, [client]);

  return (
    <>
      <section className="section settings-card">
        <div className="settings-title-row">
          <h3 className="settings-title">{project.name}</h3>
          <button className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
        </div>
        {/* A project can exist before its code does, so this is often absent. */}
        {project.localPath && <p className="muted">{project.localPath}</p>}
      </section>
      {/* Hidden rather than disabled when Linear is not connected:
          nothing arrives from Linear without a connection, so the
          toggle would be a switch that does nothing. */}
      {status?.connected && (
        <AutoStartCard client={client} project={project} onChanged={onChanged} />
      )}
      <CreateIssuesCard
        client={client}
        project={project}
        status={status}
        loadFailed={loadFailed}
        onChanged={onChanged}
      />
      <BetaOnly>
        <SandboxProviderCard client={client} projectId={project.id} onChanged={onChanged} />
      </BetaOnly>
    </>
  );
}

const SANDBOX_PROVIDER_HELP =
  "Applies to new cards. Cards that already have a sandbox keep it until they finish. Auto starts on Fly Sprites and moves to Modal when Fly cannot provide a machine.";

/** The order Auto tries providers in, as the server resolves it. */
const AUTO_ORDER = ["sprite", "modal"];

function providerName(provider: string): string {
  if (provider === "sprite") return "Fly Sprites";
  if (provider === "modal") return "Modal";
  return provider;
}

/**
 * What a choice does on this server. Auto names the providers it
 * would try here, in order, so a server with only one of them does
 * not promise a fallback it cannot make.
 */
function sandboxProviderLabel(provider: string, setting: SandboxProviderSetting): string {
  if (provider === "auto") {
    const order = AUTO_ORDER.filter((p) => setting.available.includes(p)).map(providerName);
    return order.length > 0 ? `Auto (${order.join(", then ")})` : "Auto (deployment default)";
  }
  const name = providerName(provider);
  return provider === setting.default ? `${name} (deployment default)` : name;
}

function isSandboxProvider(value: string): value is SandboxProvider {
  return value === "auto" || value === "docker" || value === "sprite" || value === "modal";
}

/**
 * Which sandbox new cards on this project are created on. A new
 * project is on Auto; a named provider pins it. Hidden when the server
 * says this person is not a beta tester. Disabled when they can see
 * the project but are not an owner or admin.
 */
function SandboxProviderCard({
  client,
  projectId,
  onChanged,
}: {
  client: BentoClient;
  projectId: string;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [choice, setChoice] = useState<SandboxProviderSetting | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client
      .getSandboxProvider(projectId)
      .then((value) => {
        if (!cancelled) setChoice(value);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setHidden(true);
        else toast.fail(err);
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  async function choose(next: string) {
    if (!choice) return;
    const sandboxProvider = next === "" || next === choice.default ? null : next;
    if (sandboxProvider !== null && !isSandboxProvider(sandboxProvider)) return;
    setBusy(true);
    try {
      await client.updateProject(projectId, { sandboxProvider });
      setChoice({ ...choice, current: sandboxProvider });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setHidden(true);
      else toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!choice) return <SettingsCardSkeleton rows={2} />;

  const defaultIsListed = choice.available.includes(choice.default);
  const selected = choice.current ?? (defaultIsListed ? choice.default : "");

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Sandbox provider</h3>
      <p className="muted">{SANDBOX_PROVIDER_HELP}</p>
      <label className="field">
        <span className="label">Provider</span>
        <select
          className="select"
          aria-label="Sandbox provider"
          value={selected}
          disabled={busy || !choice.canManage}
          onChange={(e) => void choose(e.target.value)}
        >
          {!defaultIsListed && <option value="">Deployment default</option>}
          {choice.available.map((provider) => (
            <option key={provider} value={provider}>
              {sandboxProviderLabel(provider, choice)}
            </option>
          ))}
        </select>
      </label>
      {!choice.canManage && <p className="muted">Only an owner or admin can change this.</p>}
    </section>
  );
}

/**
 * The inbound direction: whether an issue arriving from Linear enters
 * the first stage instead of waiting in the backlog.
 */
function AutoStartCard({
  client,
  project,
  onChanged,
}: {
  client: BentoClient;
  project: Project;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function setAutoStart(next: boolean) {
    setBusy(true);
    try {
      await client.updateProject(project.id, { autoStartPipeline: next });
      onChanged();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Cards arriving from Linear</h3>
      <p className="muted">
        Issues arriving from Linear become cards here. Start the pipeline and they go straight to
        the first stage; otherwise they wait in the backlog.
      </p>
      <label className="gate-check">
        <input
          type="checkbox"
          checked={project.autoStartPipeline}
          disabled={busy}
          onChange={(e) => void setAutoStart(e.target.checked)}
        />
        <span className="gate-check-text">Start the pipeline when an issue arrives from Linear.</span>
      </label>
    </section>
  );
}

/**
 * The outbound direction: where this project's cards go in Linear.
 * Each project decides for itself: on unless someone turns it off, so a
 * connected workspace sees the work either way round.
 *
 * Both selects fall back to the name stored with the project when
 * Linear cannot be reached, because a select whose value matches none of
 * its options renders blank, and blank here reads as "nothing is set"
 * when something is.
 */
function CreateIssuesCard({
  client,
  project,
  status,
  loadFailed,
  onChanged,
}: {
  client: BentoClient;
  project: Project;
  status: LinearConnection | null;
  loadFailed: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [teams, setTeams] = useState<LinearTeamOption[]>([]);
  const [linearProjects, setLinearProjects] = useState<LinearProjectOption[]>([]);
  const [busy, setBusy] = useState(false);

  const connected = status?.connected ?? false;
  useEffect(() => {
    if (!connected) return;
    void client
      .listLinearTeams()
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [client, connected]);

  const teamId = project.linearTeamId;
  useEffect(() => {
    if (!connected || !teamId) {
      setLinearProjects([]);
      return;
    }
    void client
      .listLinearProjects(teamId)
      .then(setLinearProjects)
      .catch(() => setLinearProjects([]));
  }, [client, connected, teamId]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  const intro = (
    <p className="muted">
      A card created here files a Linear issue, which then follows the card: its state changes as
      the card moves.
    </p>
  );

  if (loadFailed) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">Cards created in Bento</h3>
        {intro}
        <p className="error">
          Could not reach the server, so this cannot say whether Linear is connected.
        </p>
      </section>
    );
  }
  if (!status) return <SettingsCardSkeleton rows={3} />;
  if (!status.connected) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">Cards created in Bento</h3>
        {intro}
        <p className="muted">Linear is not connected yet. Connect it under Settings, then Linear.</p>
      </section>
    );
  }

  /** The mapped team wins over the one picked here; see the field copy. */
  const mapped = status.mappings.some((m) => m.projectId === project.id);

  const teamOptions =
    teamId && !teams.some((team) => team.id === teamId)
      ? [
          { id: teamId, key: project.linearTeamKey ?? "", name: project.linearTeamName ?? "the saved team" },
          ...teams,
        ]
      : teams;
  const projectOptions =
    project.linearProjectId && !linearProjects.some((p) => p.id === project.linearProjectId)
      ? [
          { id: project.linearProjectId, name: project.linearProjectName ?? "the saved project" },
          ...linearProjects,
        ]
      : linearProjects;

  const disabled = busy || !status.canManage;

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Cards created in Bento</h3>
      {intro}
      <label className="gate-check">
        <input
          type="checkbox"
          checked={project.linearCreateIssues}
          disabled={disabled}
          onChange={(e) =>
            void act(() => client.setProjectLinearSettings(project.id, { createIssues: e.target.checked }))
          }
        />
        <span className="gate-check-text">File a Linear issue for every card created in this project.</span>
      </label>
      {project.linearCreateIssues && !mapped && !teamId && (
        <p className="muted">No team yet, so cards here file nothing. Pick one below.</p>
      )}
      <div className="field">
        <h4 className="field-heading">Team</h4>
        <p className="muted">
          The team new issues are filed in. A team mapped to this project wins over this choice.
        </p>
        <select
          className="input"
          value={teamId ?? ""}
          disabled={disabled}
          aria-label="Linear team for new issues"
          onChange={(e) =>
            void act(() => client.setProjectLinearSettings(project.id, { teamId: e.target.value || null }))
          }
        >
          <option value="">No team</option>
          {teamOptions.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
              {team.key ? ` (${team.key})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <h4 className="field-heading">Linear project</h4>
        <p className="muted">
          The Linear project those issues join. Optional, and it applies to the team above only.
        </p>
        <select
          className="input"
          value={project.linearProjectId ?? ""}
          disabled={disabled || !teamId}
          aria-label="Linear project for new issues"
          onChange={(e) =>
            void act(() =>
              client.setProjectLinearSettings(project.id, { linearProjectId: e.target.value || null }),
            )
          }
        >
          <option value="">No project</option>
          {projectOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
