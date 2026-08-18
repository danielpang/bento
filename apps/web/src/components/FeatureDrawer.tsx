import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AgentSession } from "./AgentSession.js";
import { criterionName, useDismissable } from "./ui.js";
import { useToast } from "./Toasts.js";
import { ConfirmDialog, PromptDialog } from "./PromptDialog.js";
import type {
  AgentProfile,
  AgentRun,
  BentoClient,
  Feature,
  FeatureChanges,
  FeatureEvent,
  FeaturePullRequest,
  GateState,
  RunArtifact,
  Stage,
} from "@bento/api-client";

// The viewer carries the markdown renderer, and mermaid behind that:
// none of it belongs in the bundle of a drawer most cards open only to
// press Approve.
const ArtifactViewer = lazy(() =>
  import("./ArtifactViewer.js").then((m) => ({ default: m.ArtifactViewer })),
);
import { actorDisplayName, historyTriggerLabel, spendCoverageNote, type AgentEvent } from "@bento/core";

interface DrawerProps {
  client: BentoClient;
  feature: Feature;
  stages: Stage[];
  profiles: AgentProfile[];
  /** Bumped by the board stream when a run on this card changes state. */
  runsVersion: number;
  onClose: () => void;
  onChanged: () => void;
  onEvent: (featureId: string, event: AgentEvent) => void;
}

/** Runs in these states are over, so there is nothing to stop. */
/**
 * What this card has cost, and how much of that is actually known.
 *
 * Bento prices nothing itself: it records the figure the CLI prints,
 * and Codex, Cursor, and opencode print none. A bare total would read
 * as a cheap card rather than an unmeasured one, so the runs that
 * reported nothing are counted out loud.
 */
function CardSpend({ runs }: { runs: AgentRun[] }) {
  const finished = runs.filter((r) => TERMINAL_RUN.has(r.status));
  if (finished.length === 0) return null;
  const measured = finished.filter((r) => r.costUsd !== null && r.costUsd !== undefined);
  const total = measured.reduce((sum, r) => sum + Number(r.costUsd), 0);
  const silent = finished.length - measured.length;

  return (
    <p className="muted" title={spendCoverageNote()}>
      {measured.length > 0 ? `$${total.toFixed(2)} across ${measured.length} of ${finished.length} runs.` : "Cost not reported."}
      {silent > 0 && ` ${silent} run${silent === 1 ? "" : "s"} reported no cost, so this is a floor, not a total.`}
    </p>
  );
}

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled"]);

export function FeatureDrawer({ client, feature, stages, profiles, runsVersion, onClose, onChanged, onEvent }: DrawerProps) {
  const toast = useToast();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [dialog, setDialog] = useState<"none" | "rollback" | "reject">("none");
  const [gate, setGate] = useState<GateState | null>(null);
  const [history, setHistory] = useState<FeatureEvent[]>([]);
  const [changes, setChanges] = useState<FeatureChanges | null>(null);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  /** The artifact open in the viewer, when one is. */
  const [openArtifact, setOpenArtifact] = useState<RunArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the last publish said, when it did not simply work. */
  const [publishNotes, setPublishNotes] = useState<{ text: string; failed?: boolean }[]>([]);
  /** True while a publish request is in flight, which on hosted can be a minute. */
  const [publishing, setPublishing] = useState(false);
  /** The card's open pull requests, one per repository it was published to. */
  const [pullRequests, setPullRequests] = useState<FeaturePullRequest[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  /**
   * Whether anything can actually open a pull request. Offering an
   * enabled button that can only fail is how a missing setting gets
   * mistaken for a broken feature.
   */
  const [canPublish, setCanPublish] = useState<boolean | null>(null);
  const panel = useDismissable<HTMLElement>(onClose);

  const stage = stages.find((s) => s.id === feature.currentStageId);
  // The server sends runs newest first.
  const latestRun = runs[0];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [detail, gateState, events, committed, github, produced] = await Promise.all([
          client.getFeature(feature.id),
          client.getGate(feature.id),
          client.getHistory(feature.id),
          client.getChanges(feature.id).catch(() => null),
          client.githubStatus().catch(() => null),
          client.listArtifacts(feature.id).catch(() => []),
        ]);
        if (cancelled) return;
        setRuns(detail.runs);
        setPullRequests(detail.pullRequests ?? []);
        setGate(gateState);
        setHistory(events);
        setChanges(committed);
        setArtifacts(produced);
        setCanPublish(github ? github.canPublish : null);
        setLoadFailed(false);
      } catch {
        // Empty sections would read as "nothing has happened", which is
        // a claim, not a shrug. Say the load failed instead.
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // runsVersion: a run starting or finishing anywhere (another tab,
    // the API, an auto-start) must surface here, or the drawer offers
    // Stop for a run that is over and hides it for one that is going.
  }, [client, feature.id, feature.status, feature.currentStageId, runsVersion]);


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

  /** The on-demand half of publishing: push the branch and open the PRs now. */
  async function publishNow() {
    setBusy(true);
    setPublishing(true);
    setPublishNotes([]);
    // The request wakes the sandbox, pushes, and opens the pull request
    // in one go, which can take a minute on a hibernated one. A silent
    // button read as a dead one, and the repeat clicks queued nothing.
    toast.note("Creating the pull request. It will show up here shortly.");
    try {
      const { published, failures } = await client.publishFeature(feature.id);
      // Successes are not reported in words: they appear as rows in the
      // Pull requests section, which is where they still are tomorrow.
      // Only what went wrong, or the fact that nothing happened, needs
      // saying out loud.
      setPublishNotes(
        failures.length > 0
          ? failures.map((f) => ({ text: `Could not publish ${f.name}: ${f.reason}`, failed: true }))
          : published.length > 0
            ? []
            : [{ text: "Nothing to publish: the branch has no commits beyond the base branch." }],
      );
      // Merge rather than replace: a repository with no new commits is
      // not in this answer, and its pull request is still open.
      if (published.length > 0) {
        setPullRequests((current) => {
          const fresh = new Map(
            published.map((pr) => [pr.url, { name: pr.name, number: pr.prNumber, url: pr.url }]),
          );
          return [...current.filter((pr) => !fresh.has(pr.url)), ...fresh.values()];
        });
      }
      onChanged();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
      setPublishing(false);
    }
  }

  // The server sends artifacts newest first; a path captured by several
  // runs shows once, as its latest capture. Older ones stay reachable
  // through nothing yet, which is deliberate: the list is for review,
  // not archaeology.
  const visibleArtifacts = artifacts.filter(
    (artifact, index) => artifacts.findIndex((other) => other.path === artifact.path) === index,
  );
  // What the Artifacts section already covers, so the Changes section
  // below does not show the same write-up a second time as raw text.
  const capturedPaths = new Set(artifacts.map((artifact) => artifact.path));

  const stageAgent = profiles.find((p) => p.id === stage?.defaultAgentProfileId);
  /**
   * A done card keeps the stage it finished in, so "is it in a stage"
   * says yes about a card no stage action applies to. The status is the
   * truth here, and it picks which of three action sets this drawer
   * shows: finished, in a stage, or in the backlog.
   */
  const finished = feature.status === "done" || feature.status === "cancelled";
  // Approving mid-run would advance the card out from under the working
  // agent; the button says why it is waiting instead of failing later.
  const runActive = !!latestRun && !TERMINAL_RUN.has(latestRun.status);

  return (
    <aside className="drawer" role="dialog" aria-label={feature.title} ref={panel}>
      <header className="drawer-head">
        <div className="drawer-title-row">
          <h2 className="drawer-title">{feature.title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {/* Labeled, because three bare boxes read as mystery tokens:
            which one is the stage and which one is the status is only
            obvious to whoever wrote them. */}
        <div className="drawer-meta">
          <div className="meta-item">
            <span className="meta-label">Stage</span>
            <span className="chip">{stage ? stage.name : "Backlog"}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="chip" data-status={feature.status}>{statusWords(feature.status)}</span>
          </div>
          {feature.branchName && (
            <div className="meta-item meta-item-wide">
              <span className="meta-label">Branch</span>
              <span className="chip chip-clip" title={feature.branchName}>{feature.branchName}</span>
            </div>
          )}
        </div>
      </header>

      <div className="drawer-body drawer-body-sectioned">
        {loadFailed && (
          <p className="error" role="alert">
            Could not load this card's details. Check the connection and reopen the card.
          </p>
        )}
        <section className="section">
          <span className="label">Actions</span>
          {/*
            A card in the backlog is in no stage, so there is no gate to
            approve, reject or re-check: the server refuses all three
            with "feature is not in a stage". Offering them anyway made
            the primary button on a new card the one that could only
            fail. Starting the pipeline is the only thing to do here, so
            it is the only thing offered.
          */}
          {finished && (
            <p className="muted">
              This card is finished. Reopen it to change something; it comes back to where it left off.
            </p>
          )}
          {/* One grid, so buttons line up in even columns instead of
              wrapping wherever a row happens to run out. */}
          <div className="action-grid">
            {finished ? (
              <button className="btn" disabled={busy} onClick={() => act(() => client.moveFeatureBack(feature.id))}>
                Reopen
              </button>
            ) : feature.currentStageId ? (
              <>
                <button
                  className="btn btn-primary"
                  disabled={busy || runActive}
                  title={runActive ? "An agent is working this card. Stop it or wait for it to finish." : undefined}
                  onClick={() => act(() => client.approveFeature(feature.id))}
                >
                  Approve and advance
                </button>
                {/* The other half of a manual gate: not right yet, so back
                    it goes to where the fixing happens. */}
                <button className="btn" disabled={busy} onClick={() => setDialog("reject")}>
                  Reject
                </button>
                {/* A manual stage has no requirements to re-read, so
                    offering the button there was offering a no-op. */}
                {stage?.gateType !== "manual" && (
                  <button className="btn" disabled={busy} onClick={() => act(() => client.recheckGate(feature.id))}>
                    Re-check requirements
                  </button>
                )}
                <button className="btn" disabled={busy} onClick={() => act(() => client.moveFeatureBack(feature.id))}>
                  Send back a stage
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => act(() => client.advanceFeature(feature.id))}
              >
                Start pipeline
              </button>
            )}
            {/*
              Done from wherever the card is, without walking it through
              the stages that are left. The board's Done lane takes a
              drop for the same reason, and this is the way there for
              anyone not using a mouse. Not the primary button anywhere:
              finishing early is the exception, and reopening is one
              click away when it was the wrong call.
            */}
            {!finished && (
              <button className="btn" disabled={busy} onClick={() => act(() => client.finishFeature(feature.id))}>
                Mark done
              </button>
            )}
            {stageAgent && feature.currentStageId && !finished && (
              <button
                className="btn"
                disabled={busy}
                title={`${stageAgent.cli} ${stageAgent.model}`}
                onClick={() => act(() => client.startRun({ featureId: feature.id, agentProfileId: stageAgent.id }))}
              >
                Run {stageAgent.name}
              </button>
            )}
            {/* Both act on the card's work, which a finished card no
                longer accepts: continue is refused outright, and an
                undo would silently rewrite a card everyone stopped
                watching. Reopen first, then these come back. */}
            {latestRun?.checkpointId && !finished && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => setDialog("rollback")}
              >
                Undo this run
              </button>
            )}
            {/* Publish on demand, whatever the stage settings say. The
                branch exists once the card has been worked, which is
                also when there is something to publish. */}
            {/* Shown even when it cannot run, disabled with the reason.
                Hiding it meant somebody looking for the control could
                not find out it existed, let alone what it wanted. */}
            {feature.branchName && (
              pullRequests.length > 0 ? (
                /* Made, so the door becomes the destination. The Pull
                    requests section lists every repository's; this leads
                    to the first, mirroring the card's own pr_number. */
                <a
                  className="btn"
                  href={pullRequests[0]!.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open pull request #${pullRequests[0]!.number} in ${pullRequests[0]!.name} on GitHub`}
                >
                  Open PR #{pullRequests[0]!.number} <ExternalMark />
                </a>
              ) : (
                <button
                  className="btn"
                  disabled={busy || runActive || canPublish === false}
                  title={
                    canPublish === false
                      ? "Needs a GitHub connection. Save a GitHub token under Settings, GitHub."
                      : runActive
                        ? "An agent is working this card. Publish when it finishes."
                        : undefined
                  }
                  onClick={() => void publishNow()}
                >
                  {publishing ? "Creating PR..." : "Create PR"}
                </button>
              )
            )}
          </div>
          {/* What publishing said this time: nothing to push, or a
              repository that refused. The pull requests themselves are
              a property of the card, not of the last button press, so
              they have their own section below. */}
          {publishNotes.map((note, i) => (
            <p key={i} className={note.failed ? "warn" : "muted"}>
              {note.text}
            </p>
          ))}
          {/* Why the last run failed, where the eye lands. The same
              sentence closes the transcript, but a person looking at a
              red card reads the actions first. */}
          {latestRun?.status === "failed" && latestRun.error && !finished && (
            <p className="error">{latestRun.error}</p>
          )}
          <CardSpend runs={runs} />


          {dialog === "reject" && (
            <PromptDialog
              title="Reject this card"
              description="It goes back a stage, to the backlog from the first, so the work can be redone."
              label="Reason (optional)"
              placeholder="The API shape does not match the design"
              submitLabel="Reject and send back"
              allowEmpty
              onClose={() => setDialog("none")}
              onSubmit={(reason) => act(() => client.rejectFeature(feature.id, reason || undefined))}
            />
          )}
          {dialog === "rollback" && latestRun && (
            <ConfirmDialog
              title="Undo this run?"
              description="The sandbox goes back to how it was before the agent started. Anything it wrote since is lost."
              confirmLabel="Undo the run"
              destructive
              onClose={() => setDialog("none")}
              onConfirm={() => act(() => client.rollbackRun(latestRun.id))}
            />
          )}
        </section>

        {/* One row per repository this card was published to. Its own
            section rather than a list inside Actions: these outlive the
            button that made them, and nesting them there left nothing
            to draw a line between. */}
        {pullRequests.length > 0 && (
          <section className="section">
            <span className="label">Pull requests</span>
            {pullRequests.map((pr) => (
              <a
                key={pr.url}
                className="pr-row"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                title={`Open pull request #${pr.number} in ${pr.name} on GitHub`}
              >
                <span className="pr-repo">{pr.name}</span>
                <span className="pr-number">#{pr.number}</span>
                <ExternalMark />
              </a>
            ))}
          </section>
        )}

        {/* Always rendered while the card is in a stage. Hiding it when
            there were no rows meant a manual stage, the commonest way a
            card waits, explained itself with blank space. */}
        {feature.currentStageId && !finished && (
          <section className="section">
            <span className="label">What has to happen here</span>
            {gate && gate.checks.length > 0 ? (
              gate.checks.map((check, i) => (
                <div key={check.id} className="gate-check">
                  {check.status === "passed" ? (
                    /*
                     * Keyed on the status so the check draws when a
                     * requirement passes and not on every re-render of
                     * the drawer. Staggered down the list, which makes
                     * the order they cleared in visible: with four rows
                     * settling at once, that ordering is the only thing
                     * saying which one was waiting on the others.
                     */
                    <GateTick key={`${check.id}-passed`} index={i} />
                  ) : (
                    <span className="dot" data-state={check.status === "failed" ? "failed" : "gated"} />
                  )}
                  <span className="gate-check-text">
                    <span className="gate-check-name">{criterionName(check.criterion.type)}</span>
                    <br />
                    {check.detail?.message ?? "Not evaluated yet"}
                  </span>
                </div>
              ))
            ) : stage?.gateType === "manual" ? (
              <p className="muted">
                You decide on this card: Approve moves it on, Reject sends it back. There are no
                automatic requirements.
              </p>
            ) : (
              <p className="muted">
                Nothing has been evaluated yet. The requirements are checked when a run finishes, or
                when you press Re-check requirements.
              </p>
            )}
          </section>
        )}

        {/*
          Who moved this card, when, and what moved it. The events were
          already fetched and formatted; without them on screen there
          was no way to see that a card had been rejected twice, or that
          a gate rather than a person sent it back.
        */}
        {history.length > 0 && (
          <section className="section">
            <span className="label">History</span>
            {(showAllHistory ? history : history.slice(-6)).map((event) => (
              <div key={event.id} className="history-row">
                <span className="history-when">{formatWhen(event.at)}</span>
                <span className="history-what">
                  {describeEvent(event, stages)} <span className="muted">{triggerLabel(event)}</span>
                </span>
              </div>
            ))}
            {history.length > 6 && (
              <button className="btn btn-ghost" onClick={() => setShowAllHistory((on) => !on)}>
                {showAllHistory ? "Show less" : `Show all ${history.length}`}
              </button>
            )}
          </section>
        )}

        {/*
          What each stage produced for people: write-ups rendered as
          documents, mockups, screenshots, diagrams. One row per file,
          newest capture of each; opening one renders it in the viewer.
        */}
        {visibleArtifacts.length > 0 && (
          <section className="section">
            <span className="label">Artifacts</span>
            <div className="artifact-list">
              {visibleArtifacts.map((artifact) => (
                <button key={artifact.id} className="artifact-row" onClick={() => setOpenArtifact(artifact)}>
                  <span className="chip">{artifactKindWords(artifact.kind)}</span>
                  <span className="artifact-name" title={artifact.path}>
                    {artifactBaseName(artifact.path)}
                  </span>
                  <span className="artifact-when">{artifact.stageName}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {openArtifact && (
          <Suspense fallback={null}>
            <ArtifactViewer client={client} artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
          </Suspense>
        )}

        {/*
          What the agents have actually produced: the stage write-ups
          and the code change itself, read from the feature branch. A
          transcript says what happened; this is what you review.
        */}
        <section className="section">
          <span className="label session-label">
            <span>Changes</span>
            {changes && changes.repositories.some((r) => r.diff.trim().length > 0) && (
              <a className="session-expand" href={`/session/${feature.id}`} target="_blank" rel="noreferrer">
                Review changes ↗
              </a>
            )}
          </span>
          {!changes || changes.repositories.length === 0 ? (
            <p className="muted">Nothing committed yet. Changes and stage write-ups appear once an agent commits.</p>
          ) : (
            changes.repositories.map((repo) => (
              <div key={repo.name} className="repo-changes">
                <p className="repo-changes-head">
                  <span className="gate-check-name">{repo.name}</span>{" "}
                  <span className="diff-add">+{repo.files.reduce((n, f) => n + f.additions, 0)}</span>{" "}
                  <span className="diff-del">-{repo.files.reduce((n, f) => n + f.deletions, 0)}</span>{" "}
                  <span className="muted">
                    in {repo.files.length} file{repo.files.length === 1 ? "" : "s"}
                  </span>
                </p>
                {/* Only write-ups the Artifacts section does not already
                    render: without the filter, a captured write-up
                    appeared twice in one drawer, once as a document and
                    once as raw text. Cards worked before capture existed
                    have no artifact rows, so their write-ups still show
                    here from git. */}
                {repo.artifacts
                  .filter(
                    (artifact) =>
                      !capturedPaths.has(artifact.path) && !capturedPaths.has(`${repo.name}/${artifact.path}`),
                  )
                  .map((artifact) => (
                    <details key={artifact.path} className="changes-block">
                      <summary>{artifact.path.replace(/^docs\/bento\//, "")} (write-up)</summary>
                      <pre className="artifact">{artifact.content}</pre>
                    </details>
                  ))}
                <details className="changes-block">
                  <summary>
                    Code changes
                    {repo.truncated ? " (truncated; the branch has the rest)" : ""}
                  </summary>
                  <ul className="changed-files">
                    {repo.files.map((f) => (
                      <li key={f.path}>
                        <span className="diff-add">+{f.additions}</span> <span className="diff-del">-{f.deletions}</span>{" "}
                        {f.path}
                      </li>
                    ))}
                  </ul>
                  <DiffView diff={repo.diff} />
                </details>
              </div>
            ))
          )}
        </section>

        <AgentSession
          client={client}
          featureId={feature.id}
          runs={runs}
          profiles={profiles}
          stages={stages}
          finished={finished}
          onChanged={onChanged}
          onEvent={onEvent}
          expandHref={`/session/${feature.id}`}
        />
      </div>
    </aside>
  );
}

/** A unified diff with the lines told apart, not syntax highlighting. */
function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return null;
  return (
    <pre className="diff">
      {diff.split("\n").map((line, i) => (
        <span key={i} className={diffLineClass(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-file";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return undefined;
}


/** Null stage means the backlog, or past the end of the pipeline. */
/** Marks a link that leaves Bento, so a new tab is not a surprise. */
function ExternalMark() {
  return (
    <svg
      className="pr-external"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-3" />
      <path d="M9.5 2H14v4.5M14 2 7.5 8.5" />
    </svg>
  );
}

function stageName(id: string | null, stages: Stage[]): string {
  if (!id) return "Backlog";
  return stages.find((s) => s.id === id)?.name ?? "a removed stage";
}

function describeEvent(event: FeatureEvent, stages: Stage[]): string {
  if (event.kind === "stage_moved") {
    // A null destination is two different stories, and the trigger
    // tells them apart: a backward move went to the backlog, a forward
    // one left the last stage, which is finishing. Reading every null
    // as finished made a rejected first stage card claim it had
    // finished the stage it was just thrown out of.
    if (!event.toStageId && event.fromStageId && !event.trigger.endsWith("_back")) {
      // Off the last stage is finishing it. Off an earlier one is a card
      // marked done with stages to spare, and "finished" said of a stage
      // that was never worked is the same wrong story in a new place.
      const last = stages[stages.length - 1];
      return last && event.fromStageId !== last.id
        ? `Done from ${stageName(event.fromStageId, stages)}`
        : `Finished ${stageName(event.fromStageId, stages)}`;
    }
    return `${stageName(event.fromStageId, stages)} to ${stageName(event.toStageId, stages)}`;
  }
  return `Status ${event.fromStatus ?? "new"} to ${event.toStatus ?? "unknown"}`;
}

/**
 * A requirement that has passed, drawn rather than simply present.
 *
 * The same 8px footprint as the dot it replaces, so a list of checks
 * keeps its alignment whatever mix of states it holds. The stroke is
 * drawn by animating dashoffset, which is a paint, not a layout.
 */
function GateTick({ index }: { index: number }) {
  return (
    <svg className="gate-tick" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.4 5 8.9 9.5 3.4"
        fill="none"
        stroke="var(--succeeded)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ animationDelay: `${index * 40}ms` }}
      />
    </svg>
  );
}

function triggerLabel(event: FeatureEvent): string {
  return historyTriggerLabel(event.trigger, actorDisplayName(event.actorName, event.actorEmail));
}

/**
 * A card's own status as a phrase. The board has always said "waiting
 * at gate" while the drawer beside it said "gated", which reads as two
 * different facts about the same card.
 */
function statusWords(status: string): string {
  switch (status) {
    case "backlog":
      return "in the backlog";
    case "active":
      return "in progress";
    case "gated":
      return "waiting at gate";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}

function formatWhen(at: string): string {
  const date = new Date(at);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** The file's own name; the row's title attribute keeps the full path. */
function artifactBaseName(path: string): string {
  return path.split("/").pop() ?? path;
}

const ARTIFACT_KIND_WORDS: Record<string, string> = {
  markdown: "Doc",
  mermaid: "Diagram",
  image: "Image",
  html: "Page",
  file: "File",
};

function artifactKindWords(kind: string): string {
  return ARTIFACT_KIND_WORDS[kind] ?? "File";
}

