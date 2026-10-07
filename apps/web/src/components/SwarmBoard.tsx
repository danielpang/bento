import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BentoClient, RunArtifact } from "@bento/api-client";
import { NewSwarmDialog } from "./NewSwarmDialog.js";
import { SwarmSettingsDialog } from "./SwarmSettingsFields.js";
import { DeleteSwarmDialog } from "./DeleteSwarmDialog.js";
import { ReopenDialog } from "./ReopenDialog.js";
import { SwarmEmpty, SwarmStrip } from "./SwarmStrip.js";
import { SwarmNodeDrawer } from "./SwarmNodeDrawer.js";
import { SwarmRunOutput, SwarmRunOutputDrawer, SwarmWorkerOutputDrawer } from "./SwarmRunOutput.js";
import { SwarmPage } from "./SwarmPage.js";
import { BoardSkeleton } from "./Skeleton.js";
import { swarmApi, type SwarmAgent } from "../swarm/client.js";
import { createModelCache } from "../swarm/layout.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type {
  NewSwarmInput,
  SwarmArtifact,
  SwarmDetail,
  SwarmNodeDetail,
  SwarmSummary,
} from "../swarm/types.js";
import {
  boardSearch,
  browserStorage,
  readSwarmId,
  readSwarmView,
  rememberSwarmId,
  rememberSwarmView,
  type SwarmView,
} from "../swarm/view-state.js";

/**
 * The artifact viewer, loaded when somebody opens one.
 *
 * Lazily, the way the card drawer loads it: it carries a markdown
 * renderer and a diagram renderer, and a swarm page that never opens
 * an artifact should not pay for either.
 */
const ArtifactViewer = lazy(() =>
  import("./ArtifactViewer.js").then((m) => ({ default: m.ArtifactViewer })),
);

/**
 * The Swarms board: the switcher, the page under it, and the drawer over
 * both.
 *
 * This is the only component that talks to the swarm endpoints, and
 * it does so through `swarmApi`. Everything below it takes plain data.
 *
 * One control the fixtures offer is still not wired to anything:
 * opening a pull request for a swarm, which is the merge queue's and
 * has no route. It renders as unavailable rather than as a button
 * that does nothing.
 *
 * The model is built here, once per change, and handed to the switcher's
 * ring, the header's ring, the tree and the outline alike. Four
 * surfaces, one set of numbers.
 */
export function SwarmBoard({
  projectId,
  client,
  surfaces,
  repositoriesMissing = false,
  onAddRepository,
}: {
  projectId: string;
  /**
   * The ordinary API client, for the artifact routes alone.
   *
   * Everything else on this board goes through `swarmApi`. The
   * artifacts are the one thing a swarm shares with a card: the same
   * routes serve both, under the same rules about never letting agent
   * bytes run on this origin, and the viewer that draws them takes
   * this client. A second fetch layer for those three URLs would be a
   * second place for those rules to be got wrong.
   */
  client: BentoClient;
  surfaces: ModeSurfaces;
  /** A swarm cannot start until the project has a checkout. */
  repositoriesMissing?: boolean;
  /** Opens Repositories, from the warning inside New swarm. */
  onAddRepository?: () => void;
}) {
  const storage = useMemo(() => browserStorage(), []);
  const [swarms, setSwarms] = useState<SwarmSummary[] | null>(null);
  const [switcherSlot, setSwitcherSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSwitcherSlot(document.getElementById("swarm-switcher-slot"));
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmDetail | null>(null);
  const detailRequest = useRef(0);
  /** The agents a swarm can be run as, for the dialogs and the drawer's picker. */
  const [agents, setAgents] = useState<SwarmAgent[]>([]);
  const [view, setView] = useState<SwarmView>(() => readSwarmView(window.location.search, storage));
  const [expanded, setExpanded] = useState<string[]>([]);
  const [folded, setFolded] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  /**
   * The open node's commits and history.
   *
   * Fetched when a node is opened rather than carried on the plan: the
   * commits are read by grepping a branch per repository for the
   * node's trailer, and a plan of two hundred nodes would pay for that
   * on every refetch of a list nobody is looking at.
   *
   * Keyed by the node it is for, so a drawer that has been switched to
   * another node does not draw the previous one's commits while the
   * new request is in flight.
   */
  const [node, setNode] = useState<SwarmNodeDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taskActionError, setTaskActionError] = useState("");
  /**
   * The instant the model is built for, moved on a slow tick rather
   * than every second. It only decides which leaves have crossed the
   * long run line, and rebuilding a two hundred node layout once a
   * second to find that out would be a frame's work per second for a
   * fact that changes every twenty minutes. The header's own clock
   * ticks separately, and does not touch the model.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  /** One cache, so the switcher, the header, the tree and the outline share a build. */
  const buildModel = useRef(createModelCache()).current;

  const loadSwarms = useCallback(
    (prefer?: string) => {
      return swarmApi
        .listSwarms(projectId)
        .then((rows) => {
          setSwarms(rows);
          setSelectedId((current) => {
            if (prefer && rows.some((row) => row.id === prefer)) return prefer;
            if (current && rows.some((row) => row.id === current)) return current;
            return readSwarmId(window.location.search, storage, projectId, rows);
          });
          setError("");
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [projectId, storage],
  );

  useEffect(() => {
    setSwarms(null);
    setDetail(null);
    setSelectedId(null);
    loadSwarms();
  }, [loadSwarms]);

  const loadNode = useCallback((swarmId: string, openTaskId: string) => {
    void swarmApi
      .getNode(swarmId, openTaskId)
      .then((next) => setNode(next))
      // A node whose detail could not be read still opens: the drawer
      // falls back to what the plan row carries and says the rest is
      // not there, rather than the board showing an error over a
      // request nobody made explicitly.
      .catch(() => setNode(null));
  }, []);

  const loadDetail = useCallback((swarmId: string) => {
    const request = ++detailRequest.current;
    return swarmApi
      .getSwarm(swarmId)
      .then((next) => {
        if (request !== detailRequest.current) return;
        setDetail(next);
        setError("");
      })
      .catch((err: unknown) => {
        if (request === detailRequest.current) setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  /**
   * What the swarm produced, asked for alongside its plan.
   *
   * Its own request because it is its own route, and a failure is not
   * an error on the page: a swarm whose artifacts could not be read
   * still has a tree worth watching, and the panel simply does not
   * draw. Refetched with the detail, so the assembled document appears
   * when the swarm finishes rather than on the next reload.
   */
  const loadArtifacts = useCallback((swarmId: string) => {
    void swarmApi
      .listArtifacts(swarmId)
      .then(setArtifacts)
      .catch(() => setArtifacts([]));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      detailRequest.current += 1;
      setDetail(null);
      setArtifacts([]);
      return;
    }
    setTaskId(null);
    setPlannerOutputOpen(false);
    setWorkerOutput(null);
    setNode(null);
    setExpanded([]);
    setFolded([]);
    setArtifacts([]);
    setOpenArtifact(null);
    rememberSwarmId(storage, projectId, selectedId);
    loadDetail(selectedId);
    loadArtifacts(selectedId);
  }, [selectedId, projectId, storage, loadDetail, loadArtifacts]);

  /*
   * A swarm is watched, not read once.
   *
   * Its planner writes the tree over minutes and the reconciler rolls
   * finishes up after the fact, so without this the page showed
   * whatever was true when it was opened: a leaf marked done here left
   * the node above it reading open until somebody reloaded, and a
   * planner at work looked like a swarm doing nothing.
   *
   * Refetches are coalesced, for the reason the card board coalesces
   * them: a swarm emits an event per task it touches, and a burst must
   * cost one round trip rather than one each. What arrives is only the
   * wake; the detail is the snapshot, so a dropped event costs nothing
   * once the next one lands, and a reconnect refetches outright
   * because nothing missed is replayed.
   */
  useEffect(() => {
    if (!selectedId) return;
    let timer: number | null = null;
    const refresh = () => {
      loadDetail(selectedId);
      // The strip's rings and counts come from the list, not the
      // detail, so they go stale in the same way.
      loadSwarms();
      // And the document, which is written at the moment the swarm
      // finishes: without this it appears on the next reload.
      loadArtifacts(selectedId);
    };
    const stop = swarmApi.streamSwarm(
      selectedId,
      () => {
        timer ??= window.setTimeout(() => {
          timer = null;
          refresh();
        }, 250);
      },
      refresh,
    );
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [selectedId, loadDetail, loadSwarms, loadArtifacts]);

  /*
   * The address carries the choice, so a link to this swarm in this
   * view opens as this swarm in this view. Replaced rather than
   * pushed: switching view is not a place in history somebody wants
   * the back button to walk through.
   */
  useEffect(() => {
    const search = boardSearch(window.location.search, { mode: "swarms", swarmId: selectedId, view });
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, [selectedId, view]);

  useEffect(() => {
    if (!selectedId || !taskId) {
      setNode(null);
      return;
    }
    setNode(null);
    loadNode(selectedId, taskId);
  }, [selectedId, taskId, loadNode]);

  const [creating, setCreating] = useState(false);
  /** Whether the settings dialog is up for the swarm on screen. */
  const [editingSettings, setEditingSettings] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Read again whenever a dialog opens, because creating a swarm is
    // what makes the install's Swarm Planner and Swarm Worker, and the
    // next dialog should offer them by name.
    void swarmApi.listAgents()
      .then((profiles) => {
        if (!cancelled) setAgents(profiles);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => { cancelled = true; };
  }, [creating, editingSettings]);
  /** Whether the reopen dialog is up for the swarm on screen. */
  const [reopening, setReopening] = useState(false);
  /** What this swarm produced for people to read, and the one that is open. */
  const [artifacts, setArtifacts] = useState<SwarmArtifact[]>([]);
  const [openArtifact, setOpenArtifact] = useState<RunArtifact | null>(null);
  const [plannerOutputOpen, setPlannerOutputOpen] = useState(false);
  const [workerOutput, setWorkerOutput] = useState<{ runId: string; taskTitle: string } | null>(null);

  const model = useMemo(
    () => buildModel(detail?.tasks ?? [], { expanded, folded, autoCollapseCompleted: detail?.swarm.status !== "done", now }),
    [buildModel, detail, expanded, folded, now],
  );

  function act(run: () => Promise<unknown>, forTask = false) {
    setBusy(true);
    if (forTask) setTaskActionError("");
    void run()
      .then(async () => {
        setError("");
        await Promise.all([
          selectedId ? loadDetail(selectedId) : Promise.resolve(),
          loadSwarms(),
        ]);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        if (forTask) setTaskActionError(message);
      })
      .finally(() => setBusy(false));
  }

  // Swarm lanes are not the project's stages: the seeded shape.
  if (swarms === null) return <BoardSkeleton projectId={null} />;

  const task = taskId ? detail?.tasks.find((row) => row.id === taskId) ?? null : null;
  const layoutNode = taskId ? model.byId.get(taskId) ?? null : null;

  return (
    <div className="swarm-board">
      {switcherSlot && createPortal(
        <SwarmStrip
          swarms={swarms}
          selectedId={selectedId}
          // The switcher reads the tree this page has in hand, so its
          // ring and the header cannot differ by a poll.
          completionFor={(swarm) =>
            swarm.id === selectedId && detail ? model.root.completion : swarm.completion
          }
          onSelect={setSelectedId}
          onNew={() => setCreating(true)}
        />,
        switcherSlot,
      )}

      {error && (
        <div className="setup-prompt" role="alert">
          <span>{error}</span>
          <button
            className="btn"
            onClick={() => {
              setError("");
              loadSwarms();
              if (selectedId) loadDetail(selectedId);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {swarms.length === 0 ? (
        <SwarmEmpty onNew={() => setCreating(true)} />
      ) : detail ? (
        <SwarmPage
          detail={detail}
          model={model}
          view={view}
          onView={(next) => {
            setView(next);
            rememberSwarmView(storage, next);
          }}
          selectedId={taskId}
          onSelect={(id) => { setTaskActionError(""); setTaskId(id); }}
          onToggleNode={(id) => {
            if (model.byId.get(id)?.collapsed) {
              setFolded((current) => current.filter((entry) => entry !== id));
              setExpanded((current) => current.includes(id) ? current : [...current, id]);
            } else {
              setExpanded((current) => current.filter((entry) => entry !== id));
              setFolded((current) => current.includes(id) ? current : [...current, id]);
            }
          }}
          surfaces={surfaces}
          busy={busy}
          artifacts={artifacts}
          /*
           * Handed to the viewer that draws a card's artifacts, which
           * is where the rules about agent bytes live. The row the
           * list route sends is the shape that viewer takes, so it is
           * passed through rather than re-fetched.
           */
          onOpenArtifact={(artifact) => setOpenArtifact(artifact as RunArtifact)}
          onOpenPlannerOutput={() => setPlannerOutputOpen(true)}
          actions={{
            onPause: () => selectedId && act(() => swarmApi.pauseSwarm(selectedId)),
            onResume: () => selectedId && act(() => swarmApi.resumeSwarm(selectedId)),
            onRetryPlanner: () => selectedId && act(() => swarmApi.retryPlanner(selectedId)),
            onStop: () => selectedId && act(() => swarmApi.stopSwarm(selectedId)),
            onReleaseBranch: () => selectedId && act(() => swarmApi.releaseSwarmBranch(selectedId)),
            onReopen: () => setReopening(true),
            onDelete: () => selectedId && setDeleting({ id: selectedId, name: detail.swarm.name }),
            onArchive: () => selectedId && act(() => swarmApi.archiveSwarm(selectedId)),
            onRestore: () => selectedId && act(() => swarmApi.restoreSwarm(selectedId)),
            onWorkers: (workers) => selectedId && act(() => swarmApi.setWorkers(selectedId, workers)),
            onSettings: () => setEditingSettings(true),
            onAnswer: (questionId, text) =>
              selectedId && act(() => swarmApi.answerQuestion(selectedId, questionId, text)),
          }}
        />
      ) : (
        <BoardSkeleton projectId={null} />
      )}

      {task && layoutNode && (
        <SwarmNodeDrawer
          /*
           * One drawer instance per node, and not one drawer that
           * different nodes take turns in.
           *
           * The drawer holds a description somebody is part way
           * through editing and the text of a split they are part way
           * through writing. Without this, clicking another node in
           * the tree reused the instance: the header changed, the
           * unsaved draft did not, and Save then wrote one node's text
           * onto the other node's row.
           */
          key={task.id}
          task={task}
          node={layoutNode}
          {...(node?.taskId === task.id ? { detail: node } : {})}
          busy={busy}
          actionError={taskActionError}
          onClose={() => { setTaskActionError(""); setTaskId(null); }}
          // act reloads the detail, so the rings above the node move
          // as soon as the reconciler has rolled the finish up.
          onMarkDone={(id) => selectedId && act(() => swarmApi.markTaskDone(selectedId, id), true)}
          agents={agents}
          onRetry={(id) => selectedId && act(() => swarmApi.retryTask(selectedId, id), true)}
          onRetryLanding={(id) => selectedId && act(() => swarmApi.retryLanding(selectedId, id), true)}
          onFixForward={(id, reason) => selectedId && act(() => swarmApi.retryTask(selectedId, id, reason), true)}
          onOpenRun={(runId) => {
            setWorkerOutput({ runId, taskTitle: task.title });
            setTaskId(null);
          }}
          onCancel={(id) => selectedId && act(() => swarmApi.cancelTask(selectedId, id), true)}
          onSplit={(id, children) => selectedId && act(() => swarmApi.splitTask(selectedId, id, children), true)}
          onAddTask={(parentId, task) => selectedId && act(() => swarmApi.addTask(selectedId, parentId, task), true)}
          onReassign={(id, agentProfileId) =>
            selectedId && act(() => swarmApi.reassignTask(selectedId, id, agentProfileId), true)
          }
          onEdit={(id, edit) => selectedId && act(() => swarmApi.editTask(selectedId, id, edit), true)}
          transcript={task.assignedRunId || node?.runs?.[0]?.id ? <SwarmRunOutput client={client} runId={task.assignedRunId ?? node!.runs![0]!.id} agentName="Worker agent" /> : undefined}
        />
      )}

      {workerOutput && (
        <SwarmWorkerOutputDrawer
          client={client}
          runId={workerOutput.runId}
          taskTitle={workerOutput.taskTitle}
          onClose={() => setWorkerOutput(null)}
        />
      )}

      {plannerOutputOpen && selectedId && detail?.plannerRun && (
        <SwarmRunOutputDrawer
          client={client}
          api={swarmApi}
          swarmId={selectedId}
          swarmStatus={detail.swarm.status}
          runId={detail.plannerRun.id}
          runStatus={detail.plannerRun.status}
          runError={detail.plannerRun.error}
          agentName={detail.plannerRun.agent?.name ?? "Planner agent"}
          canRetry={detail.swarm.status === "planning" && !detail.tasks.some((task) => task.nodeType === "leaf" && task.status !== "cancelled")}
          busy={busy}
          onRetry={() => { setPlannerOutputOpen(false); act(() => swarmApi.retryPlanner(selectedId)); }}
          onStop={() => act(() => swarmApi.stopPlanner(selectedId))}
          onMessageSent={() => {
            loadDetail(selectedId);
            loadSwarms();
          }}
          onClose={() => setPlannerOutputOpen(false)}
        />
      )}

      {openArtifact && (
        <Suspense fallback={null}>
          <ArtifactViewer client={client} artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
        </Suspense>
      )}

      {editingSettings && detail && selectedId && (
        <SwarmSettingsDialog
          swarm={detail.swarm}
          agents={agents}
          busy={busy}
          onClose={() => setEditingSettings(false)}
          onSave={async (change) => {
            setBusy(true);
            try {
              await swarmApi.updateSettings(selectedId, change);
              setEditingSettings(false);
              loadDetail(selectedId);
              setError("");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {reopening && detail && selectedId && (
        <ReopenDialog
          swarm={detail.swarm}
          pullRequests={detail.pullRequests}
          landings={detail.landings}
          busy={busy}
          onClose={() => setReopening(false)}
          onReopen={(input) => {
            setBusy(true);
            void swarmApi
              .reopenSwarm(selectedId, input)
              .then(() => {
                setReopening(false);
                // The follow up node is new, so the tree this page
                // holds is out of date until the detail comes back.
                loadDetail(selectedId);
                loadSwarms();
                setError("");
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        />
      )}

      {creating && (
        <NewSwarmDialog
          projectId={projectId}
          agents={agents}
          surfaces={surfaces}
          busy={busy}
          repositoriesMissing={repositoriesMissing}
          onAddRepository={
            onAddRepository
              ? () => {
                  setCreating(false);
                  onAddRepository();
                }
              : undefined
          }
          onClose={() => setCreating(false)}
          onCreate={async (input: NewSwarmInput) => {
            setBusy(true);
            try {
              const created = await swarmApi.createSwarm(input);
              setCreating(false);
              loadSwarms(created.swarm.id);
              setSelectedId(created.swarm.id);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {deleting && (
        <DeleteSwarmDialog
          name={deleting.name}
          onClose={() => setDeleting(null)}
          onDelete={async () => {
            await swarmApi.deleteSwarm(deleting.id);
            setSelectedId(null);
            setDetail(null);
            loadSwarms();
          }}
        />
      )}
    </div>
  );
}
