import { useEffect, useState } from "react";
import { useDismissable } from "./ui.js";
import { useToast } from "./Toasts.js";
import { ConfirmDialog } from "./PromptDialog.js";
import { ConnectGitHubAccount } from "./GitHubIdentity.js";
import { RepoCardSkeleton, Skeleton } from "./Skeleton.js";
import type {
  BentoClient,
  GitHubConnection,
  GitHubInstallationOption,
  GitHubRepository,
  Repository,
} from "@bento/api-client";

/**
 * The checkouts a project spans, with its own door in the topbar.
 *
 * This used to live at the top of the Pipeline drawer, where nobody
 * thought to look for it: repositories are a property of the project,
 * not of the stages, and a person wanting to add one scans the topbar
 * for the word. Now the word is there.
 */
export function RepositoriesPanel({
  client,
  projectId,
  onClose,
}: {
  client: BentoClient;
  projectId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const panel = useDismissable<HTMLElement>(onClose);
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [newRepo, setNewRepo] = useState("");
  const [github, setGitHub] = useState<GitHubConnection | null>(null);
  const [githubChecked, setGitHubChecked] = useState(false);
  const [available, setAvailable] = useState<GitHubRepository[]>([]);
  /** Installations of the App this user could adopt for the organization. */
  const [adoptable, setAdoptable] = useState<GitHubInstallationOption[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [removing, setRemoving] = useState<Repository | null>(null);
  /**
   * Whether the GitHub check itself failed, which is not the same as
   * GitHub being unconfigured. Collapsing the two offered a local path
   * field on a hosted install, where no such path can ever resolve.
   */
  const [githubUnknown, setGitHubUnknown] = useState(false);

  useEffect(() => {
    setRepos(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    void client
      .listRepositories(projectId)
      .then(setRepos)
      .catch((err: unknown) => {
        toast.fail(err);
        setRepos([]);
      });
  }, [client, projectId, busy]);

  useEffect(() => {
    void client.githubStatus().then(async (status) => {
      setGitHub(status);
      setGitHubUnknown(false);
      setAvailable(status.connected ? await client.listGitHubRepositories() : []);
      // An installation a GitHub owner approved from a request exists
      // on GitHub with no callback ever reaching us. Offer it for
      // adoption; an empty list costs one quiet request. Skipped
      // without a GitHub account attached, because the answer is then
      // empty by definition: it is that account's installations we ask
      // for.
      if (status.configured && !status.connected && status.canManage && status.identityLinked) {
        setAdoptable(await client.listGitHubInstallations().catch(() => []));
      } else {
        setAdoptable([]);
      }
    }).catch(() => {
      // Only a real failure lands here now that every mode answers the
      // status route; before this, "no GitHub App" and "the check did
      // not run" were the same silence.
      setGitHub(null);
      setGitHubUnknown(true);
    }).finally(() => setGitHubChecked(true));
  }, [client, busy]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label="Repositories" ref={panel}>
      <header className="drawer-head">
        <div className="drawer-title-row">
          <h2 className="drawer-title">Repositories</h2>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          The git checkouts this project spans, each its own worktree inside a card's workspace.
          The first is the main one: stage summaries and the leading pull request go there.
        </p>
        {/* Said once, at the top, because it explains both fields below
            and is the thing people are most surprised by: a sandbox is
            not a machine with everything on it. */}
        <p className="muted">
          Sandboxes carry git and the coding agents, but no language runtime. Set a setup command
          to install what a repository needs, and a test command for the agent to check its own work.
        </p>
      </header>

      <div className="drawer-body">

        {!projectId && <p className="muted">Create a project first.</p>}
        {projectId && (
          <section className="section">
            {repos === null ? (
              <>
                <RepoCardSkeleton />
                <RepoCardSkeleton />
              </>
            ) : (
              repos.map((repo, i) => (
              <div key={repo.id} className="repo-card">
                <div className="repo-card-head">
                  {/* Order is meaningful: the first repository is the
                      main one, so it is numbered rather than left to be
                      inferred from position on the page. */}
                  <span className="lane-ord">{String(i + 1).padStart(2, "0")}</span>
                  <span className="repo-card-name">{repo.name}</span>
                  {i === 0 && <span className="chip chip-soft">main</span>}
                  <button
                    className="btn btn-ghost"
                    disabled={busy || repos.length === 1}
                    title={repos.length === 1 ? "A project keeps at least one repository" : undefined}
                    onClick={() => setRemoving(repo)}
                    aria-label={`Remove ${repo.name}`}
                  >
                    Remove
                  </button>
                </div>
                <span className="repo-card-path" title={repo.localPath}>
                  {repo.localPath}
                </span>
                <RepositoryCommands
                  repo={repo}
                  busy={busy}
                  onSave={(commands) =>
                    act(() => client.updateRepository(projectId, repo.id, commands))
                  }
                />
              </div>
            ))
            )}
            {!githubChecked ? (
              <div className="skeleton-stack">
                <Skeleton height={12} width="70%" />
                <Skeleton height={36} />
              </div>
            ) : githubUnknown ? (
              <div className="actions">
                <p className="muted">
                  Could not check GitHub access. Retry once the server is reachable.
                </p>
                <button className="btn" disabled={busy} onClick={() => act(async () => {})}>
                  Retry
                </button>
              </div>
            ) : github?.configured ? (
              github.connected ? (
                <div className="actions">
                  <select
                    className="input"
                    value={selectedRepoId}
                    onChange={(e) => setSelectedRepoId(e.target.value)}
                    aria-label="GitHub repository"
                  >
                    <option value="">Choose a GitHub repository</option>
                    {available
                      .filter((candidate) => !(repos ?? []).some((repo) => repo.githubRepoId === String(candidate.id)))
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>{candidate.fullName}</option>
                      ))}
                  </select>
                  <button
                    className="btn btn-primary"
                    disabled={busy || !selectedRepoId}
                    onClick={() =>
                      act(async () => {
                        const selected = available.find((repo) => String(repo.id) === selectedRepoId);
                        if (!selected) return;
                        await client.addRepository(projectId, {
                          githubRepoId: String(selected.id),
                          name: selected.name,
                          localPath: selected.fullName,
                          repoUrl: selected.url,
                          defaultBranch: selected.defaultBranch,
                        });
                        setSelectedRepoId("");
                      })
                    }
                  >
                    Add repository
                  </button>
                </div>
              ) : (
                <div className="actions">
                  <p className="muted">Connect GitHub and choose which repositories Bento may read and write.</p>
                  {github.canManage && (!github.identityLinked ? (
                    /* First things first. Installing binds an
                       installation to this organization, and Bento only
                       does that for someone GitHub already shows it to,
                       so an account made with an email and a password
                       has a GitHub account to attach before the install
                       button means anything. */
                    <ConnectGitHubAccount status={github} returnTo="/" />
                  ) : (
                    <>
                      {/* An approved request first: the App is already
                          installed on GitHub and only needs adopting,
                          which one click finishes. */}
                      {adoptable.map((option) => (
                        <button
                          key={option.installationId}
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => act(() => client.connectGitHubInstallation(option.installationId))}
                        >
                          Connect {option.accountLogin ?? "installation"}
                        </button>
                      ))}
                      <button
                        className={adoptable.length > 0 ? "btn" : "btn btn-primary"}
                        disabled={busy}
                        onClick={() => act(async () => {
                          const { url } = await client.startGitHubInstall();
                          window.location.assign(url);
                        })}
                      >
                        Install GitHub App
                      </button>
                      <p className="muted">
                        If your GitHub organization requires approval, the install becomes a
                        request to its owners and appears here once approved. Everything else
                        keeps working in the meantime.
                      </p>
                    </>
                  ))}
                </div>
              )
            ) : (
              <div className="actions">
                <input
                  className="input"
                  placeholder="/path/to/another/checkout"
                  value={newRepo}
                  onChange={(e) => setNewRepo(e.target.value)}
                  spellCheck={false}
                  aria-label="Repository path"
                />
                <button
                  className="btn btn-primary"
                  disabled={busy || !newRepo.trim()}
                  onClick={() =>
                    act(async () => {
                      await client.addRepository(projectId, { localPath: newRepo.trim() });
                      setNewRepo("");
                    })
                  }
                >
                  Add repository
                </button>
              </div>
            )}
          </section>
        )}

        {/* Removing a checkout changes what every future card works in,
            which is too much to hang on one stray click. */}
        {removing && projectId && (
          <ConfirmDialog
            title={`Remove ${removing.name}?`}
            description="New cards stop checking it out, and stages lose the code they read from it. Pull requests already open are left alone."
            confirmLabel="Remove repository"
            destructive
            onClose={() => setRemoving(null)}
            onConfirm={() => act(() => client.removeRepository(projectId, removing.id))}
          />
        )}
      </div>
    </aside>
  );
}

/**
 * The two commands, editable in place.
 *
 * Kept beside the checkout they belong to rather than in project
 * settings: which toolchain a repository needs is a fact about that
 * repository, and a project spanning three of them needs three
 * different answers.
 */
function RepositoryCommands({
  repo,
  busy,
  onSave,
}: {
  repo: Repository;
  busy: boolean;
  onSave: (commands: { setupCommand: string | null; testCommand: string | null }) => void;
}) {
  const [setup, setSetup] = useState(repo.setupCommand ?? "");
  const [test, setTest] = useState(repo.testCommand ?? "");
  // Saved values win when the server sends fresh ones, unless something
  // is being typed here: reloading mid-edit would discard it.
  const dirty = setup !== (repo.setupCommand ?? "") || test !== (repo.testCommand ?? "");

  return (
    <div className="repo-commands">
      <label className="field">
        <span className="label">Setup command</span>
        <textarea
          className="input textarea-grow repo-command-input"
          value={setup}
          onChange={(e) => setSetup(e.target.value)}
          placeholder={"curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && npm ci"}
          spellCheck={false}
          rows={2}
        />
      </label>
      <label className="field">
        <span className="label">Test command</span>
        <textarea
          className="input textarea-grow repo-command-input"
          value={test}
          onChange={(e) => setTest(e.target.value)}
          placeholder="npm test"
          spellCheck={false}
          rows={2}
        />
      </label>
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={busy || !dirty}
          onClick={() => onSave({ setupCommand: setup.trim() || null, testCommand: test.trim() || null })}
        >
          Save commands
        </button>
        {dirty && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => {
              setSetup(repo.setupCommand ?? "");
              setTest(repo.testCommand ?? "");
            }}
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
