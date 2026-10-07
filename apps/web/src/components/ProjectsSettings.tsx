import { useEffect, useState } from "react";
import type { BentoClient, Project } from "@bento/api-client";
import { desktop } from "../desktop.js";
import { rememberProjectSelection } from "../project-selection.js";
import { Modal } from "./Modal.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { ProjectsSettingsList, projectsSettingsHref } from "./ProjectsSettingsList.js";
import { NewProjectDialog, PromptDialog } from "./PromptDialog.js";
import { useToast } from "./Toasts.js";

/**
 * The projects list, and each project's own settings behind it.
 * Creating one lives here as well as on the board: this is where
 * projects are managed, and removing takes every card with it.
 *
 * The server scopes the list per request, so in multi mode this is the
 * active organization's projects and nothing else.
 */
export function ProjectsSettings({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  /** Distinct from an empty list: "no projects yet" on a failed request is a lie. */
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which project's settings are open, held as an id rather than a row:
   * the rows are refetched after every edit, and a held copy would go
   * on showing the values from before the edit. From the address first,
   * so a reload or a shared link lands on the same project.
   */
  const [openId, setOpenId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("project"),
  );

  async function load() {
    try {
      setProjects(await client.listProjects());
      setFailed(false);
    } catch (err) {
      setFailed(true);
      toast.fail(err);
    }
  }

  useEffect(() => {
    void load();
  }, [client]);

  function show(id: string | null) {
    setOpenId(id);
    // The address mirrors the open project so a reload or a shared
    // link lands on the same settings.
    history.replaceState(null, "", projectsSettingsHref(id));
  }

  async function addProject(
    name: string,
    repositories: { localPath?: string; githubRepoId?: string; repoUrl?: string; name?: string; defaultBranch?: string }[],
  ) {
    const created = await client.createProject({ name, repositories });
    // Same as creating from the board: the new project becomes the one
    // that is selected when they go back.
    rememberProjectSelection(created.id, Boolean(desktop));
    await load();
    show(created.id);
  }

  // A stale id (an organization switch, a removed project) simply falls
  // back to the list; the rows here are already scoped to this tenant.
  const open = projects?.find((p) => p.id === openId) ?? null;
  if (open) {
    return (
      <ProjectSettings
        client={client}
        project={open}
        onBack={() => show(null)}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <>
      <ProjectsSettingsList
        projects={projects}
        failed={failed}
        busy={busy}
        onNew={() => setCreating(true)}
        onRename={setRenaming}
        onRemove={setRemoving}
        onOpen={show}
      />

      {creating && (
        <NewProjectDialog client={client} onClose={() => setCreating(false)} onSubmit={addProject} />
      )}

      {renaming && (
        <PromptDialog
          title={`Rename ${renaming.name}`}
          description="Only the name changes. Repositories, cards, and the pipeline stay exactly as they are."
          label="Project name"
          submitLabel="Rename"
          initialValue={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            if (name === renaming.name) return;
            setBusy(true);
            try {
              await client.updateProject(renaming.id, { name });
              await load();
            } catch (err) {
              toast.fail(err);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {removing && (
        <RemoveProjectDialog
          client={client}
          project={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => void load()}
        />
      )}
    </>
  );
}

/** What goes with it. Null is a count that failed, so it says less rather than guessing. */
function whatGoesWithIt(cards: number | null): string {
  const undone = "This cannot be undone.";
  if (cards === null) {
    return `Its cards, their runs and transcripts, its repositories, and its pipeline all go with it. ${undone}`;
  }
  if (cards === 0) return `It has no cards. Its repositories and its pipeline go with it. ${undone}`;
  return `Its ${cards} card${cards === 1 ? "" : "s"}, their runs and transcripts, its repositories, and its pipeline all go with it. ${undone}`;
}

/**
 * "And its cards" can mean two or two hundred, so the cards are counted
 * first and the number goes in the sentence. The name has to be typed:
 * a Remove sitting beside a Rename is close enough to reach by accident.
 */
function RemoveProjectDialog({
  client,
  project,
  onClose,
  onRemoved,
}: {
  client: BentoClient;
  project: Project;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const [cards, setCards] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmed = typed.trim() === project.name;

  useEffect(() => {
    void client
      .listFeatures(project.id)
      .then((rows) => setCards(rows.length))
      .catch(() => setCards(null));
  }, [client, project.id]);

  async function remove() {
    if (!confirmed || busy) return;
    setBusy(true);
    try {
      const { deletedCards } = await client.deleteProject(project.id);
      toast.note(
        deletedCards === 0
          ? `Removed ${project.name}`
          : `Removed ${project.name} and ${deletedCards} card${deletedCards === 1 ? "" : "s"}`,
      );
      onRemoved();
      onClose();
    } catch (err) {
      // Kept open: the usual refusal is an agent still working a card.
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Remove ${project.name}?`}
      description={whatGoesWithIt(cards)}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="remove-project" className="btn btn-danger" disabled={busy || !confirmed}>
            Remove project
          </button>
        </>
      }
    >
      <form
        id="remove-project"
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <label className="field">
          <span className="label">Type the project name to confirm</span>
          <input
            className="input"
            value={typed}
            placeholder={project.name}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </label>
      </form>
    </Modal>
  );
}
