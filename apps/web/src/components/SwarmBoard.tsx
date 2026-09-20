import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NewSwarmDialog } from "./NewSwarmDialog.js";
import { SwarmEmpty, SwarmStrip } from "./SwarmStrip.js";
import { SwarmNodeDrawer } from "./SwarmNodeDrawer.js";
import { SwarmPage } from "./SwarmPage.js";
import { BoardSkeleton } from "./Skeleton.js";
import { swarmApi } from "../swarm/client.js";
import { createModelCache } from "../swarm/layout.js";
import type { ModeSurfaces } from "../swarm/plan.js";
import type { NewSwarmInput, SwarmDetail, SwarmSummary, SwarmTemplate } from "../swarm/types.js";
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
 * The Swarms board: the strip, the page under it, and the drawer over
 * both.
 *
 * This is the only component that talks to the swarm endpoints, and
 * it does so through `swarmApi`. Everything below it takes plain data.
 *
 * Two controls the fixtures once offered are not wired to anything:
 * opening a pull request for a swarm, and marking a leaf done by hand.
 * Neither has a route, so neither gets a handler, and the surfaces
 * render them as unavailable rather than as buttons that do nothing.
 *
 * The model is built here, once per change, and handed to the strip's
 * ring, the header's ring, the tree and the outline alike. Four
 * surfaces, one set of numbers.
 */
export function SwarmBoard({
  projectId,
  surfaces,
}: {
  projectId: string;
  surfaces: ModeSurfaces;
}) {
  const storage = useMemo(() => browserStorage(), []);
  const [swarms, setSwarms] = useState<SwarmSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmDetail | null>(null);
  const [templates, setTemplates] = useState<SwarmTemplate[]>([]);
  const [view, setView] = useState<SwarmView>(() => readSwarmView(window.location.search, storage));
  const [expanded, setExpanded] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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

  /** One cache, so the strip, the header, the tree and the outline share a build. */
  const buildModel = useRef(createModelCache()).current;

  const loadSwarms = useCallback(
    (prefer?: string) => {
      void swarmApi
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

  useEffect(() => {
    void swarmApi
      .listTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  const loadDetail = useCallback((swarmId: string) => {
    void swarmApi
      .getSwarm(swarmId)
      .then((next) => {
        setDetail(next);
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setTaskId(null);
    setExpanded([]);
    rememberSwarmId(storage, projectId, selectedId);
    loadDetail(selectedId);
  }, [selectedId, projectId, storage, loadDetail]);

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

  const [creating, setCreating] = useState(false);

  const model = useMemo(
    () => buildModel(detail?.tasks ?? [], { expanded, now }),
    [buildModel, detail, expanded, now],
  );

  function act(run: () => Promise<unknown>) {
    setBusy(true);
    void run()
      .then(() => {
        if (selectedId) loadDetail(selectedId);
        loadSwarms();
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }

  if (swarms === null) return <BoardSkeleton />;

  const task = taskId ? detail?.tasks.find((row) => row.id === taskId) ?? null : null;
  const node = taskId ? model.byId.get(taskId) ?? null : null;

  return (
    <div className="swarm-board">
      <SwarmStrip
        swarms={swarms}
        selectedId={selectedId}
        // The open swarm's tab reads the tree this page has in hand,
        // so the tab and the header cannot differ by a poll.
        completionFor={(swarm) =>
          swarm.id === selectedId && detail ? model.root.completion : swarm.completion
        }
        onSelect={setSelectedId}
        onNew={() => setCreating(true)}
        onRestore={(swarmId) => act(() => swarmApi.restoreSwarm(swarmId))}
      />

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
          onSelect={setTaskId}
          onToggleNode={(id) =>
            setExpanded((current) =>
              current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
            )
          }
          surfaces={surfaces}
          busy={busy}
          actions={{
            onPause: () => selectedId && act(() => swarmApi.pauseSwarm(selectedId)),
            onResume: () => selectedId && act(() => swarmApi.resumeSwarm(selectedId)),
            onStop: () => selectedId && act(() => swarmApi.stopSwarm(selectedId)),
            onWorkers: (workers) => selectedId && act(() => swarmApi.setWorkers(selectedId, workers)),
            onAnswer: (questionId, text) =>
              selectedId && act(() => swarmApi.answerQuestion(selectedId, questionId, text)),
          }}
        />
      ) : (
        <BoardSkeleton />
      )}

      {task && node && (
        <SwarmNodeDrawer task={task} node={node} busy={busy} onClose={() => setTaskId(null)} />
      )}

      {creating && (
        <NewSwarmDialog
          projectId={projectId}
          templates={templates}
          surfaces={surfaces}
          busy={busy}
          onClose={() => setCreating(false)}
          onCreate={(input: NewSwarmInput) => {
            setBusy(true);
            void swarmApi
              .createSwarm(input)
              .then((created) => {
                setCreating(false);
                loadSwarms(created.swarm.id);
                setSelectedId(created.swarm.id);
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}
