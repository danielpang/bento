import { useEffect, useState, type FormEvent } from "react";
import type { BentoClient, GitHubConnection, GitHubRepository } from "@bento/api-client";
import { ConnectGitHubAccount } from "./GitHubIdentity.js";
import { Modal } from "./Modal.js";
import { ListRowsSkeleton } from "./Skeleton.js";

/**
 * One field and a submit, the replacement for `window.prompt`.
 *
 * Enter submits and Escape closes, so the keyboard path is the one the
 * browser dialog had. Submitting is refused while the field is empty
 * rather than accepting an empty string, which is what a prompt returns
 * when someone presses Enter on an untouched field.
 */
export function PromptDialog({
  title,
  description,
  label,
  placeholder,
  submitLabel,
  multiline = false,
  initialValue = "",
  allowEmpty = false,
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  multiline?: boolean;
  initialValue?: string;
  /** For a field that is genuinely optional, such as a reason. */
  allowEmpty?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if ((!trimmed && !allowEmpty) || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      {...(description ? { description } : {})}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="prompt-dialog" className="btn btn-primary" disabled={busy || (!allowEmpty && !value.trim())}>
            {submitLabel}
          </button>
        </>
      }
    >
      <form id="prompt-dialog" onSubmit={submit}>
        <label className="field">
          <span className="label">{label}</span>
          {/* Asked for here rather than left to the dialog: a one field
              dialog exists to be typed into, and Modal no longer focuses
              whatever comes first on its own. */}
          {multiline ? (
            <textarea
              className="input"
              rows={4}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              // A textarea keeps Enter for newlines, so submit is the
              // modifier chord the rest of the web uses.
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
              }}
            />
          ) : (
            <input
              className="input"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          )}
        </label>
      </form>
    </Modal>
  );
}

/**
 * Grows a textarea to fit what has been typed, up to a limit.
 *
 * A description is where someone explains what they actually want, and
 * a box that stays three lines tall while the text scrolls out of sight
 * asks them to write less. Height is reset before it is measured, or
 * the box could only ever grow.
 */
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}

/**
 * A card is a title and a description, and the description is the part
 * an agent actually works from.
 *
 * They were one field: everything typed became the title, so a card
 * carrying any detail had a title several lines long and an empty
 * description, and the board then showed that wall of text on the card.
 */
export function NewFeatureDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (title: string, description: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = title.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(title.trim(), description.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New card"
      description="A short title for the board, and the detail the agents work from."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="new-feature" className="btn btn-primary" disabled={busy || !ready}>
            Add
          </button>
        </>
      }
    >
      <form id="new-feature" onSubmit={submit}>
        <label className="field">
          <span className="label">Title</span>
          <input
            className="input input-lg"
            value={title}
            placeholder="Add a rate limit to the public API"
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span className="label">Description</span>
          <textarea
            className="input input-lg textarea-grow"
            value={description}
            rows={5}
            placeholder="What should exist when this is done? Anything the agent should know: the endpoints involved, the limits, what to leave alone."
            onChange={(e) => {
              setDescription(e.target.value);
              autoGrow(e.target);
            }}
            // Enter is for newlines here, so submit is the chord the
            // rest of the console uses.
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
          />
          <span className="muted">
            Optional. Enter starts a new line; {navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}Enter adds the card.
          </span>
        </label>
        {error && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}

/**
 * A project needs a name; checkouts are asked for together with it so
 * the second answer cannot strand the first, but on a hosted install
 * they are optional. The person naming the project is not always the
 * person who can connect the GitHub App, and holding the project
 * hostage to the installation chained the two: create now, connect
 * under Repositories later.
 *
 * More than one checkout is offered here rather than only afterwards
 * because a project that spans a frontend and a backend spans them from
 * the start: adding the second in a different screen makes the common
 * case look like an edit to a mistake.
 */
export function NewProjectDialog({
  client,
  onClose,
  onSubmit,
}: {
  client: BentoClient;
  onClose: () => void;
  onSubmit: (
    name: string,
    repositories: { localPath?: string; githubRepoId?: string; repoUrl?: string; name?: string; defaultBranch?: string }[],
  ) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  // Always at least one row, so the field is never absent.
  const [paths, setPaths] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [github, setGitHub] = useState<GitHubConnection | null>(null);
  const [githubChecked, setGitHubChecked] = useState(false);
  const [githubRepos, setGitHubRepos] = useState<GitHubRepository[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const filled = paths.map((p) => p.trim()).filter(Boolean);
  const hosted = Boolean(github?.configured);
  // Hosted: a name is enough, repositories can arrive after the App is
  // connected. Local: a checkout is the project, so one is required.
  const ready = githubChecked && name.trim().length > 0 && (hosted || filled.length > 0);

  useEffect(() => {
    void client.githubStatus().then(async (status) => {
      setGitHub(status);
      if (status.connected) setGitHubRepos(await client.listGitHubRepositories());
    }).catch(() => setGitHub(null)).finally(() => setGitHubChecked(true));
  }, [client]);

  function setPath(index: number, value: string) {
    setPaths((current) => current.map((p, i) => (i === index ? value : p)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const repositories = hosted
        ? selectedRepoIds.flatMap((id) => {
            const repo = githubRepos.find((candidate) => String(candidate.id) === id);
            return repo
              ? [{
                  githubRepoId: String(repo.id),
                  repoUrl: repo.url,
                  localPath: repo.fullName,
                  name: repo.name,
                  defaultBranch: repo.defaultBranch,
                }]
              : [];
          })
        : filled.map((localPath) => ({ localPath }));
      await onSubmit(name.trim(), repositories);
      onClose();
    } catch (err) {
      // Kept open on failure: a bad path is worth correcting rather
      // than retyping, which is what closing would cost.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New project"
      description={
        hosted
          ? "Name the project, and optionally choose repositories granted to the Bento GitHub App."
          : "Point Bento at a git repository on this machine. Add more than one if a change usually spans them."
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="new-project" className="btn btn-primary" disabled={busy || !ready}>
            Create
          </button>
        </>
      }
    >
      <form id="new-project" onSubmit={submit}>
        <label className="field">
          <span className="label">Name</span>
          <input
            className="input"
            value={name}
            placeholder="Payments revamp"
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </label>
        {!githubChecked ? (
          <ListRowsSkeleton rows={4} />
        ) : hosted ? (
          <div className="field">
            <span className="label">GitHub repositories</span>
            {!github?.connected ? (
              github?.canManage ? (
                <>
                  {/* Installing binds an installation to the
                      organization, which Bento only does for someone
                      GitHub already shows it to. An account made with
                      an email and a password has no GitHub identity
                      yet, so that step comes first here rather than as
                      a refusal on the way back from GitHub. */}
                  {github.identityLinked ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void client.startGitHubInstall().then(({ url }) => window.location.assign(url))}
                    >
                      Install GitHub App
                    </button>
                  ) : (
                    <ConnectGitHubAccount status={github} returnTo="/" primary={false} />
                  )}
                  <p className="muted">
                    Or create the project now and connect GitHub under Repositories later.
                  </p>
                </>
              ) : (
                <p className="muted">
                  An organization admin can connect the GitHub App. The project can be created
                  now either way; repositories are added under Repositories once it is connected.
                </p>
              )
            ) : githubRepos.length === 0 ? (
              <p className="muted">
                The GitHub App is installed but no repositories are selected for it, so there is
                nothing to choose here. Pick them on GitHub, or create the project now and add
                them later.
              </p>
            ) : (
              githubRepos.map((repo) => {
                const id = String(repo.id);
                return (
                  <label key={id} className="gate-check">
                    <input
                      type="checkbox"
                      checked={selectedRepoIds.includes(id)}
                      onChange={(e) => setSelectedRepoIds((current) =>
                        e.target.checked ? [...current, id] : current.filter((value) => value !== id)
                      )}
                    />
                    <span className="gate-check-text">{repo.fullName}</span>
                  </label>
                );
              })
            )}
          </div>
        ) : (
        <div className="field">
          <span className="label">{paths.length === 1 ? "Repository path" : "Repository paths"}</span>
          {paths.map((value, index) => (
            <div key={index} className="actions">
              <input
                className="input"
                value={value}
                placeholder={index === 0 ? "/Users/you/code/checkout" : "/Users/you/code/another"}
                onChange={(e) => setPath(index, e.target.value)}
                spellCheck={false}
                aria-label={`Repository path ${index + 1}`}
              />
              {paths.length > 1 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => setPaths((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove repository path ${index + 1}`}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setPaths((current) => [...current, ""])}
            >
              Add another repository
            </button>
          </div>
          {/* The order is the workspace order, and the first is where a
              stage's summary is written and its pull request opened. */}
          {filled.length > 1 && (
            <p className="muted">
              Each becomes its own checkout inside a card's workspace. The first is the main one.
            </p>
          )}
        </div>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}

/** A yes or no, the replacement for `window.confirm`. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive = false,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title={title}
      description={description}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
