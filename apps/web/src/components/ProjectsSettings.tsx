import { useEffect, useState } from "react";
import type { BentoClient, Project } from "@bento/api-client";
import { Modal } from "./Modal.js";
import { PromptDialog } from "./PromptDialog.js";
import { useToast } from "./Toasts.js";

/**
 * The projects this session can see, and what can be done to one after
 * it exists.
 *
 * Creating a project happens on the board, because that is where you
 * are when you want another one. Renaming and removing are not board
 * work: a name is usually wrong because the project was called after
 * the first repository somebody added, and removing a project takes
 * every card with it, which is not a thing to keep a button for beside
 * the control that starts agents.
 *
 * In multi mode the list is the active organization's projects and
 * nothing else, because the server scopes it per request. Switching
 * organizations under Team therefore changes what is listed here.
 */
export function ProjectsSettings({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  /**
   * Whether the list failed to load, which is not the same as having no
   * projects yet. "No projects yet" on a failed request is a claim about
   * the team rather than about the request.
   */
  const [failed, setFailed] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Projects</h3>
      <p className="muted">
        Every board belongs to a project. Renaming one changes what it is called everywhere;
        removing one takes its cards, its runs, and its pipeline with it.
      </p>

      {failed ? (
        <p className="error">Could not load the projects. Retry once the server is reachable.</p>
      ) : projects === null ? (
        <p className="muted">Loading projects...</p>
      ) : projects.length === 0 ? (
        <p className="muted">No projects yet. Create one from the board.</p>
      ) : (
        projects.map((project) => (
          <div key={project.id} className="gate-check">
            <span className="gate-check-text">
              <span className="gate-check-name">{project.name}</span>
              {/* The checkout, when there is one. A project can exist
                  before its code does, so this is often absent and the
                  row simply says less. */}
              {project.localPath && (
                <>
                  <br />
                  {project.localPath}
                </>
              )}
            </span>
            {/* Both in the one action slot the member rows use, so the
                two buttons stay together against the right edge rather
                than drifting apart as a path wraps. */}
            <span className="member-action">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setRenaming(project)}>
                Rename
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(project)}>
                Remove
              </button>
            </span>
          </div>
        ))
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
              await client.renameProject(renaming.id, name);
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
    </section>
  );
}

/**
 * What the delete takes, in the size it actually is. Null is a count
 * that could not be fetched, which is a reason to say less rather than
 * a reason to guess.
 */
function whatGoesWithIt(cards: number | null): string {
  const undone = "This cannot be undone.";
  if (cards === null) {
    return `Its cards, their runs and transcripts, its repositories, and its pipeline all go with it. ${undone}`;
  }
  if (cards === 0) return `It has no cards. Its repositories and its pipeline go with it. ${undone}`;
  return `Its ${cards} card${cards === 1 ? "" : "s"}, their runs and transcripts, its repositories, and its pipeline all go with it. ${undone}`;
}

/**
 * Removing a project, with the size of it said out loud.
 *
 * A yes or no dialog can promise "and its cards" without either side
 * knowing whether that is two cards or two hundred, so this counts them
 * first and puts the number in the sentence. The count is a request
 * that can fail, and a failed count is not a reason to refuse the
 * delete: the dialog falls back to naming what goes without the figure.
 *
 * The name has to be typed to confirm, because this takes more than
 * any other button in the console does and a Remove sitting beside a
 * Rename is close enough to reach by accident.
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
      // Kept open on failure. The usual refusal is an agent still
      // working a card, which is worth reading beside the button that
      // caused it rather than after the dialog has gone.
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
