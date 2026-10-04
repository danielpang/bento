import type { Project } from "@bento/api-client";
import { RenameButton } from "./IconButtons.js";
import { ListRowsSkeleton } from "./Skeleton.js";

/** The Projects tab, optionally with one project's settings open. */
export function projectsSettingsHref(projectId: string | null): string {
  return projectId ? `/settings?tab=projects&project=${projectId}` : "/settings?tab=projects";
}

/**
 * The list itself, without the create / rename / remove dialogs.
 * Split out so the empty state and the New project control can be
 * asserted without mounting the GitHub-aware create dialog.
 */
export function ProjectsSettingsList({
  projects,
  failed,
  busy,
  onNew,
  onRename,
  onRemove,
  onOpen,
}: {
  projects: Project[] | null;
  failed: boolean;
  busy: boolean;
  onNew: () => void;
  onRename: (project: Project) => void;
  onRemove: (project: Project) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="section settings-card">
      <div className="settings-title-row">
        <h3 className="settings-title">Projects</h3>
        <button className="btn btn-primary" disabled={busy} onClick={onNew}>
          New project
        </button>
      </div>

      {failed ? (
        <p className="error">Could not load the projects. Retry once the server is reachable.</p>
      ) : projects === null ? (
        <ListRowsSkeleton rows={3} />
      ) : projects.length === 0 ? (
        <p className="muted">No projects yet.</p>
      ) : (
        projects.map((project) => (
          <div key={project.id} className="gate-check">
            <span className="gate-check-text">
              <span className="gate-check-name">{project.name}</span>
              <RenameButton
                label={`Rename ${project.name}`}
                disabled={busy}
                onClick={() => onRename(project)}
              />
              {/* A project can exist before its code does, so this is often absent. */}
              {project.localPath && (
                <>
                  <br />
                  {project.localPath}
                </>
              )}
            </span>
            {/* One slot for both, so they stay together as a path wraps. */}
            <span className="member-action">
              <button className="btn btn-ghost" disabled={busy} onClick={() => onOpen(project.id)}>
                Settings
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => onRemove(project)}>
                Remove
              </button>
            </span>
          </div>
        ))
      )}
    </section>
  );
}
